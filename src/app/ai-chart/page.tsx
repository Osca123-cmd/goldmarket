"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CandlestickSeries, ColorType, CrosshairMode, LineStyle, createChart, type UTCTimestamp } from "lightweight-charts";
import { AppShell } from "@/components/Shell";
import { useMarket } from "@/components/MarketContext";
import { Card, DirBadge, Empty, Stat, ago, cx, fmt, useNow } from "@/components/ui";
import { fetchCandles, useAiAnalyses, type AiAnalysisRow } from "@/lib/market";
import { friendlyError, supabase } from "@/lib/supabase";
import { AI_DAILY_LIMIT, AI_RR, AI_TFS, type AiTf } from "@/core/aiSetup";

export default function Page() {
  return (
    <AppShell>
      <AiChartPage />
    </AppShell>
  );
}

const C = { buy: "#22c58b", sell: "#f0506e", gold: "#e8b84c", muted: "#8e9cc9", line: "#1d2b5a" };
const MAX_BYTES = 4 * 1024 * 1024;

const STATUS: Record<AiAnalysisRow["status"], { text: string; cls: string }> = {
  failed: { text: "Gagal", cls: "border-sell/40 text-sell" },
  no_setup: { text: "Tidak ada setup", cls: "border-muted/40 text-muted" },
  rejected: { text: "Ditolak validasi", cls: "border-warn/40 text-warn" },
  pending: { text: "Menunggu entry", cls: "border-gold/50 text-gold" },
  entry_touched: { text: "Berjalan", cls: "border-gold/50 bg-gold/10 text-gold" },
  expired: { text: "Kedaluwarsa", cls: "border-muted/40 text-muted" },
  invalid: { text: "Batal", cls: "border-muted/40 text-muted" },
  closed: { text: "Selesai", cls: "border-line text-ink" },
};
const OUTCOME: Record<string, { text: string; cls: string }> = {
  win: { text: "WIN", cls: "border-buy/50 bg-buy/10 text-buy" },
  loss: { text: "LOSS", cls: "border-sell/50 bg-sell/10 text-sell" },
  timeout: { text: "TIMEOUT", cls: "border-warn/40 text-warn" },
};

function StatusChip({ a }: { a: AiAnalysisRow }) {
  const o = a.status === "closed" && a.outcome ? OUTCOME[a.outcome] : null;
  const s = o ?? STATUS[a.status];
  return <span className={cx("chip font-bold", s.cls)}>{s.text}</span>;
}

async function invokeError(e: unknown): Promise<string> {
  const ctx = (e as { context?: Response })?.context;
  if (ctx && typeof ctx.json === "function") {
    try {
      const b = await ctx.json();
      if (b?.error) return String(b.error);
    } catch {
      /* jatuh ke pesan umum */
    }
  }
  return friendlyError(e);
}

function AiChartPage() {
  const now = useNow(30000);
  const { data: rows, error: rowsErr } = useAiAnalyses();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [tf, setTf] = useState<AiTf>("M15");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (!file) return setPreview(null);
    const u = URL.createObjectURL(file);
    setPreview(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  const today = useMemo(() => {
    const d = new Date(now + 7 * 3600000).toISOString().slice(0, 10);
    return (rows ?? []).filter((r) => r.status !== "failed" && new Date(Date.parse(r.created_at) + 7 * 3600000).toISOString().slice(0, 10) === d).length;
  }, [rows, now]);
  const current = (rows ?? []).find((r) => r.id === selected) ?? rows?.[0] ?? null;

  const pick = (f: File | undefined | null) => {
    setMsg(null);
    if (!f) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(f.type)) return setMsg("Hanya PNG, JPEG, atau WEBP.");
    if (f.size > MAX_BYTES) return setMsg("Ukuran maksimal 4 MB.");
    setFile(f);
  };

  const analyze = async () => {
    if (!file || busy) return;
    setBusy(true);
    setMsg(null);
    const sb = supabase();
    try {
      const { data: s } = await sb.auth.getSession();
      const uid = s.session?.user.id;
      if (!uid) throw new Error("Silakan login ulang.");
      const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
      const path = `${uid}/${crypto.randomUUID()}.${ext}`;
      const up = await sb.storage.from("chart-uploads").upload(path, file, { contentType: file.type, upsert: false });
      if (up.error) throw up.error;
      const { data, error } = await sb.functions.invoke("chart-ai", { body: { image_path: path, tf, note } });
      if (error) {
        setMsg(await invokeError(error));
        // analisa gagal tetap tercatat (status Gagal) bila model sempat dipanggil; selain itu gambar dibuang
        if (!(data as { analysis?: unknown } | null)?.analysis) await sb.storage.from("chart-uploads").remove([path]);
      } else {
        setSelected((data as { analysis?: { id: string } }).analysis?.id ?? null);
        setFile(null);
        setNote("");
      }
    } catch (e) {
      setMsg(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a: AiAnalysisRow) => {
    const sb = supabase();
    const { error } = await sb.from("ai_analyses").delete().eq("id", a.id);
    if (error) return setMsg(friendlyError(error));
    await sb.storage.from("chart-uploads").remove([a.image_path]);
    if (selected === a.id) setSelected(null);
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-bold">
          Analisa AI Gambar <span className="chip border-warn/40 bg-warn/10 text-warn">eksperimen</span>
        </h1>
        <p className="text-sm text-muted">
          Upload screenshot chart XAUUSD → AI membaca struktur dari gambar → satu setup dengan <b className="text-gold">satu TP</b> (RR 1:{AI_RR.target[0]}–1:{AI_RR.target[1]}, atau 1:{AI_RR.min}–1:{AI_RR.max} bila TP di level struktur).
        </p>
      </div>

      <div className="rounded-xl border border-warn/40 bg-warn/5 p-3 text-xs text-warn">
        Model AI gratis (Gemini, cadangan Groq) — hasilnya bisa berbeda tiap klik dan <b>belum teruji</b>; kinerja hanya diukur maju di bawah. Angka entry/SL/TP dikunci ke data XAU/USD GOLDMARKET (harga broker di gambar bisa beda ±1 USD) dan dicek aturan tetap (SL 0,5–3× ATR, RR). RR 1:5–1:6 berarti LOSS beruntun panjang wajar terjadi. Bukan saran investasi.
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <Card title="Analisa baru" action={<span className="text-xs text-muted">{today}/{AI_DAILY_LIMIT} hari ini</span>}>
          <label
            className={cx("flex min-h-40 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-3 text-center text-sm", file ? "border-gold/60" : "border-line text-muted hover:border-gold/40")}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              pick(e.dataTransfer.files?.[0]);
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {preview ? <img src={preview} alt="Pratinjau screenshot" className="max-h-56 w-full rounded-lg object-contain" /> : <span>Klik atau tarik screenshot chart XAUUSD ke sini (PNG/JPG, ≤4 MB)</span>}
            <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
          </label>
          <div className="mt-3 text-xs text-muted">Timeframe di gambar</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {AI_TFS.map((t) => (
              <button key={t} className={cx("chip", tf === t ? "border-gold/60 bg-gold/10 text-gold" : "border-line text-muted")} onClick={() => setTf(t)}>
                {t}
              </button>
            ))}
          </div>
          <textarea
            className="input mt-3 h-16 w-full resize-none text-sm"
            maxLength={300}
            placeholder="Catatan opsional (mis. fokus area demand 3990)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <button className="btn-gold mt-3 w-full disabled:opacity-50" disabled={!file || busy || today >= AI_DAILY_LIMIT} onClick={analyze}>
            {busy ? "AI sedang membaca gambar… (±10–40 detik)" : "Analisa Market"}
          </button>
          {msg && <p className="mt-2 break-words text-xs text-sell">{msg}</p>}
        </Card>

        {current ? <ResultCard a={current} now={now} /> : <Card title="Hasil"><Empty title="Belum ada analisa">Upload screenshot lalu klik Analisa Market.</Empty></Card>}
      </div>

      <AiStats rows={rows ?? []} />

      <Card title="Riwayat analisa">
        {rowsErr && <p className="mb-2 text-xs text-sell">Gagal memuat riwayat: {rowsErr}</p>}
        {!rows?.length ? (
          <p className="text-sm text-muted">{rows == null ? "Memuat…" : "Belum ada riwayat."}</p>
        ) : (
          <ul className="divide-y divide-line/60">
            {rows.map((a) => (
              <li key={a.id} className={cx("flex flex-wrap items-center gap-2 py-2 text-sm", current?.id === a.id && "text-gold")}>
                <button className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-left" onClick={() => setSelected(a.id)}>
                  <span className="num w-20 shrink-0 text-xs text-muted">{ago(a.created_at, now)}</span>
                  <span className="chip border-line text-[10px]">{a.tf}</span>
                  {a.direction && <DirBadge dir={a.direction} />}
                  <StatusChip a={a} />
                  {a.rr != null && <span className="num text-xs text-muted">RR 1:{a.rr}</span>}
                  {a.outcome_r != null && <span className={cx("num text-xs font-semibold", a.outcome_r > 0 ? "text-buy" : "text-sell")}>{a.outcome_r > 0 ? "+" : ""}{a.outcome_r}R</span>}
                </button>
                <button className="text-xs text-muted hover:text-sell" onClick={() => remove(a)} title="Hapus analisa & gambar">
                  Hapus
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function ResultCard({ a, now }: { a: AiAnalysisRow; now: number }) {
  const [img, setImg] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    supabase()
      .storage.from("chart-uploads")
      .createSignedUrl(a.image_path, 3600)
      .then(({ data }) => alive && setImg(data?.signedUrl ?? null));
    return () => {
      alive = false;
    };
  }, [a.image_path]);
  const hasSetup = a.direction && a.entry != null && a.sl != null && a.tp != null;
  return (
    <Card title={<span className="flex flex-wrap items-center gap-2">Hasil <span className="chip border-line text-[10px]">{a.tf}</span> <StatusChip a={a} /></span>} action={<span className="text-xs text-muted">{ago(a.created_at, now)} · {a.provider ?? "-"}</span>}>
      {hasSetup ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <DirBadge dir={a.direction!} />
            <span className="text-sm">{a.entry_type === "market" ? "Entry market" : "Limit"}</span>
            <span className="chip border-gold/50 bg-gold/10 font-bold text-gold">RR 1:{a.rr}</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Entry" value={fmt(a.entry)} tone="gold" />
            <Stat label="SL" value={fmt(a.sl)} sub={`${a.sl_pips} pips`} tone="sell" />
            <Stat label="TP" value={fmt(a.tp)} sub={`${a.tp_pips} pips`} tone="buy" />
          </div>
          {a.status === "closed" && <p className="text-sm">{a.outcome_note} {a.outcome_pips != null && <b className={a.outcome_pips > 0 ? "text-buy" : "text-sell"}>{a.outcome_pips > 0 ? "+" : ""}{a.outcome_pips} pips ({a.outcome_r}R)</b>}</p>}
          {(a.status === "expired" || a.status === "invalid") && <p className="text-sm text-muted">{a.outcome_note}</p>}
          {a.status === "pending" && a.expires_at && <p className="text-xs text-muted">Menunggu harga ke entry sampai {new Date(a.expires_at).toLocaleString("id-ID")}.</p>}
          <LevelChart a={a} />
          {a.target_reason && <p className="text-xs"><b className="text-muted">Target:</b> {a.target_reason}</p>}
          {a.invalidation && <p className="text-xs"><b className="text-muted">Batal bila:</b> {a.invalidation}</p>}
          {a.reasons.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5 text-xs">
              {a.reasons.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
          )}
        </div>
      ) : (
        <p className="text-sm">{a.reject_reason ?? "Tidak ada setup."}</p>
      )}
      {a.notes.length > 0 && (
        <div className="mt-3 rounded-lg border border-line/70 p-2 text-[11px] text-muted">
          {a.notes.map((n, i) => <div key={i}>• {n}</div>)}
        </div>
      )}
      {(a.summary || a.structure.length > 0) && (
        <div className="mt-3 text-xs">
          <div className="font-semibold text-muted">Bacaan AI dari gambar{a.bias ? ` · bias ${a.bias}` : ""}</div>
          {a.summary && <p className="mt-1">{a.summary}</p>}
          {a.structure.length > 0 && (
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {a.structure.map((s, i) => <li key={i}>{s}</li>)}
            </ul>
          )}
        </div>
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {img && <img src={img} alt="Screenshot yang dianalisa" className="mt-3 max-h-64 w-full rounded-lg border border-line/70 object-contain" />}
    </Card>
  );
}

/** Candle XAU/USD GOLDMARKET (TF analisa) dengan garis entry/SL/TP. */
function LevelChart({ a }: { a: AiAnalysisRow }) {
  const ref = useRef<HTMLDivElement>(null);
  const { snapshot } = useMarket();
  const source = snapshot?.source;
  useEffect(() => {
    if (!ref.current || !source) return;
    let alive = true;
    const chart = createChart(ref.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "#0b1430" }, textColor: C.muted, fontFamily: "Inter, sans-serif" },
      grid: { vertLines: { color: "#1a2333" }, horzLines: { color: "#1a2333" } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: C.line },
      timeScale: { borderColor: C.line, timeVisible: true, secondsVisible: false },
      localization: { locale: "id-ID" },
    });
    const candle = chart.addSeries(CandlestickSeries, { upColor: C.buy, downColor: C.sell, wickUpColor: C.buy, wickDownColor: C.sell, borderVisible: false });
    const pl = (price: number | null, color: string, title: string, style = LineStyle.Solid) => price != null && candle.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title });
    pl(a.entry, C.gold, `Entry ${a.entry_type ?? ""}`);
    pl(a.sl, C.sell, "SL");
    pl(a.tp, C.buy, `TP (1:${a.rr})`, LineStyle.Dashed);
    fetchCandles(source, a.tf, 150)
      .then((cs) => {
        if (!alive) return;
        candle.setData(cs.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })));
        chart.timeScale().fitContent();
      })
      .catch(() => {});
    return () => {
      alive = false;
      chart.remove();
    };
  }, [source, a.id, a.tf, a.entry, a.sl, a.tp, a.rr, a.entry_type]);
  return <div ref={ref} className="h-64 w-full overflow-hidden rounded-lg border border-line/70" />;
}

function AiStats({ rows }: { rows: AiAnalysisRow[] }) {
  const s = useMemo(() => {
    const setups = rows.filter((r) => r.direction);
    const closed = rows.filter((r) => r.status === "closed");
    const w = closed.filter((r) => r.outcome === "win").length;
    const l = closed.filter((r) => r.outcome === "loss").length;
    const totalR = closed.reduce((x, r) => x + (r.outcome_r ?? 0), 0);
    const pips = closed.reduce((x, r) => x + (r.outcome_pips ?? 0), 0);
    const filled = setups.filter((r) => r.entry_touched_at && r.rr);
    const avgRr = filled.length ? filled.reduce((x, r) => x + (r.rr ?? 0), 0) / filled.length : 5;
    return { n: rows.length, setups: setups.length, open: rows.filter((r) => r.status === "entry_touched").length, w, l, closed: closed.length, totalR, pips, breakeven: 100 / (1 + avgRr), avgRr };
  }, [rows]);
  return (
    <Card title="Kinerja maju (semua analisa Anda)">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Analisa" value={s.n} sub={`${s.setups} setup valid · ${s.open} berjalan`} />
        <Stat label="WIN / LOSS" value={`${s.w} / ${s.l}`} sub={`${s.closed} selesai`} />
        <Stat label="Win rate" value={s.closed ? `${((100 * s.w) / s.closed).toFixed(0)}%` : "—"} sub={`impas ±${s.breakeven.toFixed(1)}% @ RR rata-rata 1:${s.avgRr.toFixed(1)}`} tone="gold" />
        <Stat label="Total" value={`${s.totalR > 0 ? "+" : ""}${s.totalR.toFixed(1)}R`} sub={`${s.pips > 0 ? "+" : ""}${s.pips.toFixed(0)} pips`} tone={s.totalR >= 0 ? "buy" : "sell"} />
      </div>
      <p className="mt-2 text-xs text-muted">Sampel kecil belum berarti apa-apa; nilai setelah puluhan setup selesai. Hasil level setup menurut feed, belum termasuk spread/komisi.</p>
    </Card>
  );
}
