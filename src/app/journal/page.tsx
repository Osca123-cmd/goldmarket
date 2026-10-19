"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { AppShell } from "@/components/Shell";
import { useMarket } from "@/components/MarketContext";
import { Card, Confirm, Disclaimer, DirBadge, Empty, Field, Stat, cx, fmt, fmtMoney, fmtTime, useNow } from "@/components/ui";
import { HistoryPanel, HistoryRow, SignalHistoryItem, relTime } from "@/components/SignalHistory";
import { useSignalHistory } from "@/lib/market";
import { gradeOf } from "@/core/outcome";
import { classify } from "@/core/stats";
import { useAuth } from "@/lib/auth";
import { friendlyError, supabase } from "@/lib/supabase";
import {
  OUTCOME_LABEL,
  STATUS_LABEL,
  initialRisk,
  realizedPnl,
  remainingLot,
  rMultiple,
  tp1ReachedByFeed,
  validateAction,
  type JournalOutcome,
  type JournalPartial,
  type JournalTrade,
} from "@/core/journal";
import { sessionAt } from "@/core/sessions";
import { STRATEGY_LABEL } from "@/core/config";

/** Hasil dalam pips: rata-rata tertimbang harga keluar (partial + final) dibanding entry. */
function tradePips(t: JournalTrade, own: JournalPartial[], pipSize: number): number | null {
  const lots = own.reduce((a, p) => a + p.lot, 0);
  if (!lots) return null;
  const sgn = t.direction === "BUY" ? 1 : -1;
  return Math.round((own.reduce((a, p) => a + p.lot * sgn * (p.price - t.entry_price), 0) / lots / pipSize) * 10) / 10;
}

export default function Page() {
  return (
    <AppShell>
      <Journal />
    </AppShell>
  );
}

const NUMERIC = ["entry_price", "lot", "initial_sl", "sl", "tp1", "tp2", "tp3", "commission", "swap", "contract_size", "quote_to_account_rate"] as const;
function normTrade(r: Record<string, unknown>): JournalTrade {
  const t = { ...r } as Record<string, unknown>;
  for (const k of NUMERIC) t[k] = t[k] == null ? null : Number(t[k]);
  return t as unknown as JournalTrade;
}
function normPartial(r: Record<string, unknown>): JournalPartial {
  return { ...(r as unknown as JournalPartial), lot: Number(r.lot), price: Number(r.price) };
}

const tradeSchema = z
  .object({
    direction: z.enum(["BUY", "SELL"]),
    strategy: z.string().min(1).max(40),
    timeframe: z.string().min(1).max(8),
    entry_price: z.number().positive("Entry harus > 0"),
    lot: z.number().positive("Lot harus > 0").max(1000),
    initial_sl: z.number().positive("SL harus > 0"),
    tp1: z.number().positive().nullable(),
    tp2: z.number().positive().nullable(),
    tp3: z.number().positive().nullable(),
    opened_at: z.string().min(1),
    commission: z.number().min(0),
    swap: z.number(),
    notes: z.string().max(5000).nullable(),
  })
  .refine((t) => (t.direction === "BUY" ? t.initial_sl < t.entry_price : t.initial_sl > t.entry_price), { message: "SL harus di sisi rugi dari entry (BUY: di bawah, SELL: di atas)." })
  .refine((t) => [t.tp1, t.tp2, t.tp3].every((tp) => tp == null || (t.direction === "BUY" ? tp > t.entry_price : tp < t.entry_price)), { message: "TP harus di sisi profit dari entry." });

function Journal() {
  const { settings, session } = useAuth();
  const { snapshot, setups } = useMarket();
  const tz = settings?.display_tz ?? "Asia/Jakarta";
  const ccy = settings?.account_currency ?? "USD";
  const [trades, setTrades] = useState<JournalTrade[]>([]);
  const [partials, setPartials] = useState<JournalPartial[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "open" | "closed" | "cancelled">("all");
  const [tab, setTab] = useState<"mine" | "signals">("mine");
  const history = useSignalHistory(200);
  const signals = history.data ?? [];
  const now = useNow(30000);
  const [selected, setSelected] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [prefill, setPrefill] = useState<Partial<Record<string, string>> | null>(null);

  const load = useCallback(async () => {
    const sb = supabase();
    const [t, p] = await Promise.all([
      sb.from("journal_trades").select("*").order("opened_at", { ascending: false }).limit(1000),
      sb.from("journal_partials").select("*").order("closed_at", { ascending: true }).limit(5000),
    ]);
    if (t.error) setErr(friendlyError(t.error));
    setTrades((t.data ?? []).map(normTrade));
    setPartials((p.data ?? []).map(normPartial));
    setLoading(false);
  }, []);

  useEffect(() => {
    if (session) void load();
  }, [session, load]);

  // prefill dari setup (?fromSetup=)
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("fromSetup");
    if (!id || prefill) return;
    const s = setups.find((x) => x.id === id);
    if (!s) return;
    setPrefill({
      setup_id: s.id,
      direction: s.direction,
      strategy: s.strategy,
      timeframe: s.timeframe,
      entry_price: String(s.entry_price),
      initial_sl: String(s.sl),
      tp1: String(s.tp1),
      tp2: String(s.tp2),
      tp3: String(s.tp3),
    });
    setShowForm(true);
  }, [setups, prefill]);

  const list = trades.filter((t) => filter === "all" || t.status === filter);
  const startFromSetup = (id: string) => {
    const s = setups.find((x) => x.id === id) ?? signals.find((x) => x.id === id);
    if (!s) return;
    setPrefill({ setup_id: s.id, direction: s.direction, strategy: s.strategy, timeframe: s.timeframe, entry_price: String(s.entry_price), initial_sl: String(s.sl), tp1: String(s.tp1), tp2: String(s.tp2), tp3: String(s.tp3) });
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const sel = trades.find((t) => t.id === selected) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="mr-auto">
          <h1 className="text-xl font-bold">Jurnal Trading</h1>
          <p className="text-sm text-muted">Catatan manual Anda. Harga live tidak pernah menutup posisi, mengubah SL, atau menandai profit/loss secara otomatis.</p>
        </div>
        <button className="btn-gold" onClick={() => { setPrefill(null); setShowForm(true); }}>
          + Catat transaksi
        </button>
      </div>

      {showForm && settings && (
        <TradeForm
          key={prefill?.setup_id ?? "manual"}
          prefill={prefill}
          defaults={{ contract_size: settings.contract_size, rate: settings.quote_to_account_rate, commission: settings.commission_per_lot }}
          onClose={() => setShowForm(false)}
          onSaved={async (id) => {
            setShowForm(false);
            await load();
            setSelected(id);
          }}
        />
      )}

      <HistoryPanel
        title={tab === "mine" ? "Trade History" : "Signal History"}
        action={
          <div className="flex rounded-xl border border-line p-0.5 text-xs" role="tablist">
            <button role="tab" aria-selected={tab === "mine"} onClick={() => setTab("mine")} className={cx("rounded-lg px-3 py-1.5 font-semibold", tab === "mine" ? "bg-gold/15 text-gold" : "text-muted")}>
              Transaksi Saya
            </button>
            <button role="tab" aria-selected={tab === "signals"} onClick={() => setTab("signals")} className={cx("rounded-lg px-3 py-1.5 font-semibold", tab === "signals" ? "bg-gold/15 text-gold" : "text-muted")}>
              Riwayat Sinyal
            </button>
          </div>
        }
        summary={
          tab === "mine" ? (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {(["all", "open", "closed", "cancelled"] as const).map((k) => (
                <button key={k} onClick={() => setFilter(k)} className={cx("rounded-lg border px-2 py-1", filter === k ? "border-gold text-gold" : "border-line text-muted")}>
                  {k === "all" ? "Semua" : STATUS_LABEL[k]}
                </button>
              ))}
              <span className="ml-auto text-muted">Hasil dalam pips (rata-rata harga keluar vs entry)</span>
            </div>
          ) : (
            <p className="text-xs text-muted">Sinyal engine yang entry-nya tersentuh menurut feed, dinilai otomatis (WIN/LOSS). Terpisah dari transaksi Anda — tidak mengubah jurnal.</p>
          )
        }
      >
        {err && <p className="px-5 py-3 text-sm text-sell">{err}</p>}
        {tab === "signals" ? (
          signals.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-muted">Belum ada riwayat sinyal.</p>
          ) : (
            signals.map((h) => (
              <SignalHistoryItem
                key={h.id}
                s={h}
                tz={tz}
                price={snapshot?.price ?? null}
                grade={gradeOf(h.score)}
                time={`${relTime(h.entry_touched_at, now)} · ${STRATEGY_LABEL[h.strategy]}`}
                extra={
                  <a className="text-xs text-gold hover:underline" href={`?fromSetup=${h.id}`} onClick={(e) => { e.preventDefault(); startFromSetup(h.id); }}>
                    Catat sebagai transaksi saya →
                  </a>
                }
              />
            ))
          )
        ) : loading ? (
          <p className="px-5 py-6 text-sm text-muted">Memuat…</p>
        ) : list.length === 0 ? (
          <div className="p-4">
            <Empty title="Belum ada transaksi">Catat transaksi manual atau dari sinyal. Statistik dihitung hanya dari transaksi Anda.</Empty>
          </div>
        ) : (
          list.map((t) => {
            const own = partials.filter((p) => p.trade_id === t.id);
            const pnl = realizedPnl(t, own);
            const r = t.status === "closed" ? rMultiple(t, pnl.net) : null;
            const kind = t.status === "open" ? "open" : t.status === "cancelled" ? "cancelled" : classify(pnl.net, r, t.outcome);
            const remind = tp1ReachedByFeed(t, snapshot?.price ?? null);
            const setupScore = setups.find((x) => x.id === t.setup_id)?.score ?? signals.find((x) => x.id === t.setup_id)?.score ?? null;
            return (
              <HistoryRow
                key={t.id}
                active={selected === t.id}
                onClick={() => {
                  setSelected(t.id);
                  setTimeout(() => document.getElementById("trade-detail")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
                }}
                direction={t.direction}
                timeframe={t.timeframe}
                grade={gradeOf(setupScore)}
                time={`${relTime(t.status === "open" ? t.opened_at : (t.closed_at ?? t.opened_at), now)} · ${t.status === "closed" && t.outcome ? OUTCOME_LABEL[t.outcome] : STATUS_LABEL[t.status]}`}
                result={kind}
                pips={t.status === "cancelled" ? null : tradePips(t, own, settings?.pip_size ?? 0.1)}
                sub={
                  <>
                    {t.status !== "open" && own.length > 0 && <span className={pnl.net >= 0 ? "text-buy" : "text-sell"}>{fmtMoney(pnl.net, ccy)}{r != null ? ` · ${fmt(r)}R` : ""}</span>}
                    {remind && <span className="text-warn"> ⚑ TP1 tersentuh feed — pertimbangkan SL ke BE</span>}
                  </>
                }
              />
            );
          })
        )}
      </HistoryPanel>

      {sel && (
        <div id="trade-detail" className="scroll-mt-20">
          <TradeDetail key={sel.id} t={sel} partials={partials.filter((p) => p.trade_id === sel.id)} price={snapshot?.price ?? null} tz={tz} ccy={ccy} onChanged={load} onClose={() => setSelected(null)} />
        </div>
      )}
      <Disclaimer />
    </div>
  );
}

function toLocalInput(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function TradeForm({
  prefill,
  defaults,
  onClose,
  onSaved,
}: {
  prefill: Partial<Record<string, string>> | null;
  defaults: { contract_size: number; rate: number; commission: number };
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const [f, setF] = useState<Record<string, string>>({
    direction: prefill?.direction ?? "BUY",
    strategy: prefill?.strategy ?? "manual",
    timeframe: prefill?.timeframe ?? "M15",
    entry_price: prefill?.entry_price ?? "",
    lot: "",
    initial_sl: prefill?.initial_sl ?? "",
    tp1: prefill?.tp1 ?? "",
    tp2: prefill?.tp2 ?? "",
    tp3: prefill?.tp3 ?? "",
    opened_at: toLocalInput(new Date()),
    commission: "0",
    swap: "0",
    contract_size: String(defaults.contract_size),
    rate: String(defaults.rate),
    notes: "",
  });
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const n = (k: string) => (f[k] === "" ? null : Number(String(f[k]).replace(",", ".")));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const candidate = {
      direction: f.direction as "BUY" | "SELL",
      strategy: f.strategy,
      timeframe: f.timeframe,
      entry_price: n("entry_price") ?? NaN,
      lot: n("lot") ?? NaN,
      initial_sl: n("initial_sl") ?? NaN,
      tp1: n("tp1"),
      tp2: n("tp2"),
      tp3: n("tp3"),
      opened_at: new Date(f.opened_at).toISOString(),
      commission: n("commission") ?? 0,
      swap: n("swap") ?? 0,
      notes: f.notes.trim() || null,
    };
    const parsed = tradeSchema.safeParse(candidate);
    if (!parsed.success) return setMsg(parsed.error.issues[0].message);
    const cs = n("contract_size");
    const rate = n("rate");
    if (!(cs && cs > 0) || !(rate && rate > 0)) return setMsg("Contract size dan kurs harus > 0.");
    setBusy(true);
    const { data, error } = await supabase()
      .from("journal_trades")
      .insert({
        ...parsed.data,
        sl: parsed.data.initial_sl,
        setup_id: prefill?.setup_id ?? null,
        session: sessionAt(Date.parse(parsed.data.opened_at)),
        contract_size: cs,
        quote_to_account_rate: rate,
      })
      .select("id")
      .single();
    setBusy(false);
    if (error) return setMsg(friendlyError(error));
    onSaved(data.id);
  }

  const inp = (k: string, label: string, type = "text") => (
    <Field label={label}>
      <input className="input num" type={type} inputMode={type === "text" ? "decimal" : undefined} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
    </Field>
  );

  return (
    <Card title={prefill?.setup_id ? "Catat transaksi dari setup" : "Catat transaksi manual"}>
      <form onSubmit={save} className="space-y-3">
        <p className="text-xs text-muted">Isi dengan data AKTUAL dari broker Anda (harga fill, lot, biaya). Menyimpan di sini tidak membuka order.</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Arah">
            <select className="input" value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })}>
              <option>BUY</option>
              <option>SELL</option>
            </select>
          </Field>
          <Field label="Strategi">
            <select className="input" value={f.strategy} onChange={(e) => setF({ ...f, strategy: e.target.value })}>
              <option value="manual">Manual / lainnya</option>
              <option value="trend_pullback">Trend pullback</option>
              <option value="breakout_retest">Breakout retest</option>
            </select>
          </Field>
          <Field label="Timeframe">
            <select className="input" value={f.timeframe} onChange={(e) => setF({ ...f, timeframe: e.target.value })}>
              {["M1", "M5", "M15", "M30", "H1", "H4", "D1"].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </Field>
          {inp("opened_at", "Waktu buka", "datetime-local")}
          {inp("entry_price", "Entry aktual")}
          {inp("lot", "Lot")}
          {inp("initial_sl", "Stop loss")}
          {inp("tp1", "TP1 (opsional)")}
          {inp("tp2", "TP2 (opsional)")}
          {inp("tp3", "TP3 (opsional)")}
          {inp("commission", "Komisi (mata uang akun)")}
          {inp("swap", "Swap (+ biaya / − kredit)")}
          {inp("contract_size", "Contract size")}
          {inp("rate", "Kurs USD → akun")}
        </div>
        <Field label="Catatan">
          <textarea className="input min-h-20" maxLength={5000} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
        {msg && <p className="text-sm text-sell" role="alert">{msg}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Batal
          </button>
          <button className="btn-gold" disabled={busy}>
            {busy ? "Menyimpan…" : "Simpan ke jurnal"}
          </button>
        </div>
      </form>
    </Card>
  );
}

type Dialog =
  | { kind: "milestone"; m: "tp1" | "tp2" | "tp3" }
  | { kind: "be" }
  | { kind: "sl" }
  | { kind: "partial" }
  | { kind: "close"; outcome: JournalOutcome }
  | { kind: "cancel" }
  | null;

interface EventRow {
  id: number;
  at: string;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

function TradeDetail({ t, partials, price, tz, ccy, onChanged, onClose }: { t: JournalTrade; partials: JournalPartial[]; price: number | null; tz: string; ccy: string; onChanged: () => Promise<void>; onClose: () => void }) {
  const [dlg, setDlg] = useState<Dialog>(null);
  const [val, setVal] = useState({ price: "", lot: "", sl: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [shots, setShots] = useState<{ id: string; path: string; url: string | null }[]>([]);
  const [notes, setNotes] = useState(t.notes ?? "");
  const [fees, setFees] = useState({ commission: String(t.commission), swap: String(t.swap) });
  const pnl = realizedPnl(t, partials);
  const rem = remainingLot(t, partials);
  const remind = tp1ReachedByFeed(t, price);

  const loadExtras = useCallback(async () => {
    const sb = supabase();
    const [ev, at] = await Promise.all([
      sb.from("journal_events").select("*").eq("trade_id", t.id).order("at", { ascending: false }).limit(100),
      sb.from("journal_attachments").select("*").eq("trade_id", t.id).order("created_at"),
    ]);
    setEvents((ev.data ?? []) as EventRow[]);
    const rows = (at.data ?? []) as { id: string; path: string }[];
    const signed = await Promise.all(rows.map(async (r) => ({ ...r, url: (await sb.storage.from("journal-screenshots").createSignedUrl(r.path, 3600)).data?.signedUrl ?? null })));
    setShots(signed);
  }, [t.id]);
  useEffect(() => {
    void loadExtras();
  }, [loadExtras, t]);

  const run = async (fn: () => PromiseLike<{ error: unknown }>) => {
    setMsg(null);
    const { error } = await fn();
    if (error) {
      setMsg(friendlyError(error));
      return;
    }
    setDlg(null);
    setVal({ price: "", lot: "", sl: "" });
    await onChanged();
  };
  const sb = supabase();
  const nv = (s: string) => Number(String(s).replace(",", "."));

  const act = async () => {
    if (!dlg) return;
    if (dlg.kind === "milestone") {
      const v = validateAction(t, partials, { type: "milestone", milestone: dlg.m });
      if (v) return setMsg(v);
      return run(() => sb.from("journal_trades").update({ [`${dlg.m}_hit_at`]: new Date().toISOString() }).eq("id", t.id));
    }
    if (dlg.kind === "be") return run(() => sb.from("journal_trades").update({ sl: t.entry_price }).eq("id", t.id));
    if (dlg.kind === "sl") {
      const v = validateAction(t, partials, { type: "move_sl", sl: nv(val.sl) });
      if (v) return setMsg(v);
      return run(() => sb.from("journal_trades").update({ sl: nv(val.sl) }).eq("id", t.id));
    }
    if (dlg.kind === "partial") {
      const v = validateAction(t, partials, { type: "partial", lot: nv(val.lot), price: nv(val.price) });
      if (v) return setMsg(v);
      return run(() => sb.rpc("journal_partial_close", { p_trade_id: t.id, p_lot: nv(val.lot), p_price: nv(val.price) }));
    }
    if (dlg.kind === "close") {
      const v = validateAction(t, partials, { type: "close", outcome: dlg.outcome, price: nv(val.price) });
      if (v) return setMsg(v);
      return run(() => sb.rpc("journal_close_trade", { p_trade_id: t.id, p_price: nv(val.price), p_outcome: dlg.outcome }));
    }
    if (dlg.kind === "cancel") {
      const v = validateAction(t, partials, { type: "cancel" });
      if (v) return setMsg(v);
      return run(() => sb.from("journal_trades").update({ status: "cancelled" }).eq("id", t.id));
    }
  };

  const upload = async (file: File) => {
    setMsg(null);
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) return setMsg("Hanya PNG, JPEG, atau WEBP.");
    if (file.size > 5 * 1024 * 1024) return setMsg("Ukuran maksimal 5 MB.");
    const { data: s } = await sb.auth.getSession();
    const uid = s.session?.user.id;
    if (!uid) return;
    const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
    const path = `${uid}/${t.id}/${crypto.randomUUID()}.${ext}`;
    const up = await sb.storage.from("journal-screenshots").upload(path, file, { contentType: file.type, upsert: false });
    if (up.error) return setMsg(friendlyError(up.error));
    const ins = await sb.from("journal_attachments").insert({ trade_id: t.id, path, mime: file.type, size_bytes: file.size });
    if (ins.error) {
      await sb.storage.from("journal-screenshots").remove([path]);
      return setMsg(friendlyError(ins.error));
    }
    await loadExtras();
  };

  const DLG_TEXT: Record<string, { title: string; body: string; label: string }> = {
    milestone: { title: "Tandai milestone", body: "Menandai bahwa target ini tercapai menurut catatan Anda. Milestone tidak menutup transaksi dan tidak dihitung sebagai kemenangan terpisah.", label: "Tandai" },
    be: { title: "Pindah SL ke BE", body: `Mengubah SL jurnal menjadi harga entry (${fmt(t.entry_price)}). Hanya mengubah catatan; lakukan juga di platform broker Anda bila perlu. SL awal tetap disimpan untuk perhitungan R.`, label: "Pindah SL ke BE" },
    sl: { title: "Ubah SL jurnal", body: "Mengubah SL pada catatan jurnal. SL awal tetap dipakai untuk menghitung R.", label: "Simpan SL" },
    partial: { title: "Catat partial close", body: "Mencatat penutupan sebagian dengan harga aktual dari broker.", label: "Catat partial" },
    close: { title: "Tutup transaksi", body: "Mencatat penutupan sisa lot dengan harga keluar aktual. Status menjadi final; setelah itu hanya catatan yang dapat diubah.", label: "Tutup transaksi" },
    cancel: { title: "Batalkan transaksi", body: "Menandai transaksi sebagai dibatalkan (mis. order tidak terisi). Tidak dihitung di statistik.", label: "Batalkan" },
  };
  const d = dlg ? DLG_TEXT[dlg.kind] : null;

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          Detail transaksi <DirBadge dir={t.direction} />
        </span>
      }
      action={
        <button className="text-xs text-muted hover:text-ink" onClick={onClose}>
          Tutup panel ✕
        </button>
      }
    >
      {remind && (
        <div className="mb-3 rounded-xl border border-warn/50 bg-warn/10 p-3 text-sm text-warn">
          Harga feed ({fmt(price)}) telah mencapai TP1 {fmt(t.tp1)}. Pertimbangkan pindah SL ke BE — aplikasi tidak mengubah apa pun sampai Anda mengonfirmasi.
        </div>
      )}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 2xl:grid-cols-6">
        <Stat label="Status" value={t.status === "closed" && t.outcome ? OUTCOME_LABEL[t.outcome] : STATUS_LABEL[t.status]} />
        <Stat label="Entry / Lot" value={`${fmt(t.entry_price)} / ${fmt(t.lot)}`} sub={`Sisa lot ${fmt(rem)}`} />
        <Stat label="SL sekarang" value={fmt(t.sl)} tone="sell" sub={`SL awal ${fmt(t.initial_sl)}`} />
        <Stat label="TP1 / TP2 / TP3" value={`${fmt(t.tp1)} / ${fmt(t.tp2)} / ${fmt(t.tp3)}`} tone="buy" />
        <Stat label="Realisasi bersih" value={fmtMoney(pnl.net, ccy)} tone={pnl.net >= 0 ? "buy" : "sell"} sub={`Kotor ${fmtMoney(pnl.gross, ccy)} · biaya ${fmtMoney(pnl.fees, ccy)}`} />
        <Stat label="Risiko awal (1R)" value={fmtMoney(initialRisk(t), ccy)} sub={t.status === "closed" ? `Hasil ${fmt(rMultiple(t, pnl.net))}R` : undefined} />
      </div>
      <p className="mt-2 text-xs text-muted">
        Dibuka {fmtTime(t.opened_at, tz, true)} · sesi {t.session}
        {t.closed_at && <> · ditutup {fmtTime(t.closed_at, tz, true)}</>}
        {t.setup_id && <> · dari setup {t.setup_id.slice(0, 8)}</>} · milestone:{" "}
        {[t.tp1_hit_at && "TP1", t.tp2_hit_at && "TP2", t.tp3_hit_at && "TP3"].filter(Boolean).join(", ") || "belum ada"}
      </p>

      {t.status === "open" && (
        <div className="mt-4 space-y-2">
          <div className="flex flex-wrap gap-2">
            {(["tp1", "tp2", "tp3"] as const).map((m) => (
              <button key={m} className="btn-ghost text-xs" disabled={!!t[`${m}_hit_at`] || t[m] == null} onClick={() => setDlg({ kind: "milestone", m })}>
                Tandai {m.toUpperCase()} tercapai
              </button>
            ))}
            <button className="btn-ghost text-xs" disabled={t.sl === t.entry_price} onClick={() => setDlg({ kind: "be" })}>
              Pindah SL ke BE
            </button>
            <button className="btn-ghost text-xs" onClick={() => setDlg({ kind: "sl" })}>
              Ubah SL
            </button>
            <button className="btn-ghost text-xs" onClick={() => setDlg({ kind: "partial" })}>
              Partial close
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="self-center text-xs text-muted">Tutup sebagai:</span>
            {(["tp1", "tp2", "tp3", "sl", "be", "manual"] as JournalOutcome[]).map((o) => (
              <button key={o} className={cx("text-xs", o === "sl" ? "btn-sell" : o.startsWith("tp") ? "btn-buy" : "btn-ghost")} onClick={() => setDlg({ kind: "close", outcome: o })}>
                {OUTCOME_LABEL[o]}
              </button>
            ))}
            <button className="btn-ghost text-xs" onClick={() => setDlg({ kind: "cancel" })}>
              Batalkan (cancelled)
            </button>
          </div>
        </div>
      )}
      {msg && <p className="mt-2 text-sm text-sell" role="alert">{msg}</p>}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="min-w-0 space-y-3">
          <h4 className="card-title">Partial / penutupan tercatat</h4>
          {partials.length === 0 ? (
            <p className="text-xs text-muted">Belum ada.</p>
          ) : (
            <ul className="space-y-1 text-xs">
              {partials.map((p) => (
                <li key={p.id} className="flex justify-between gap-2">
                  <span>
                    {p.kind === "final" ? "Penutupan" : "Partial"} {fmt(p.lot)} lot @ <span className="num">{fmt(p.price)}</span>
                  </span>
                  <span className="text-muted">{fmtTime(p.closed_at, tz, true)}</span>
                </li>
              ))}
            </ul>
          )}
          <h4 className="card-title">Biaya</h4>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Komisi">
              <input className="input num" disabled={t.status !== "open"} value={fees.commission} onChange={(e) => setFees({ ...fees, commission: e.target.value })} />
            </Field>
            <Field label="Swap">
              <input className="input num" disabled={t.status !== "open"} value={fees.swap} onChange={(e) => setFees({ ...fees, swap: e.target.value })} />
            </Field>
          </div>
          {t.status === "open" && (
            <button className="btn-ghost text-xs" onClick={() => run(() => sb.from("journal_trades").update({ commission: nv(fees.commission), swap: nv(fees.swap) }).eq("id", t.id))}>
              Simpan biaya
            </button>
          )}
          <h4 className="card-title">Catatan</h4>
          <textarea className="input min-h-24" maxLength={5000} value={notes} onChange={(e) => setNotes(e.target.value)} />
          <button className="btn-ghost text-xs" onClick={() => run(() => sb.from("journal_trades").update({ notes: notes.trim() || null }).eq("id", t.id))}>
            Simpan catatan
          </button>
        </div>
        <div className="min-w-0 space-y-3">
          <h4 className="card-title">Screenshot (PNG/JPEG/WEBP, maks 5 MB)</h4>
          <input type="file" accept="image/png,image/jpeg,image/webp" className="block w-full text-xs text-muted file:mr-2 file:rounded-lg file:border-0 file:bg-surface-2 file:px-3 file:py-1.5 file:text-ink" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          <div className="grid grid-cols-2 gap-2">
            {shots.map((s) =>
              s.url ? (
                <a key={s.id} href={s.url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg border border-line">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={s.url} alt="Screenshot transaksi" className="h-28 w-full object-cover" />
                </a>
              ) : null,
            )}
          </div>
          <h4 className="card-title">Histori perubahan</h4>
          <ul className="max-h-64 space-y-1 overflow-y-auto text-xs">
            {events.map((e) => (
              <li key={e.id} className="rounded-lg bg-surface-2/60 px-2 py-1">
                <span className="text-muted">{fmtTime(e.at, tz, true)}</span> · <strong>{e.action}</strong> {describeDiff(e)}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <Confirm open={!!dlg} title={d?.title ?? ""} body={d?.body ?? ""} confirmLabel={d?.label ?? "OK"} tone={dlg?.kind === "cancel" ? "sell" : "gold"} onClose={() => { setDlg(null); setMsg(null); }} onConfirm={act}>
        {dlg && (dlg.kind === "partial" || dlg.kind === "close") && (
          <div className="grid grid-cols-2 gap-2">
            <Field label="Harga keluar aktual">
              <input className="input num" inputMode="decimal" autoFocus value={val.price} onChange={(e) => setVal({ ...val, price: e.target.value })} />
            </Field>
            {dlg.kind === "partial" ? (
              <Field label={`Lot (sisa ${fmt(rem)})`}>
                <input className="input num" inputMode="decimal" value={val.lot} onChange={(e) => setVal({ ...val, lot: e.target.value })} />
              </Field>
            ) : (
              <Field label="Lot ditutup">
                <input className="input num" disabled value={fmt(rem)} />
              </Field>
            )}
          </div>
        )}
        {dlg?.kind === "sl" && (
          <Field label="SL baru">
            <input className="input num" inputMode="decimal" autoFocus value={val.sl} onChange={(e) => setVal({ ...val, sl: e.target.value })} />
          </Field>
        )}
        {msg && <p className="mt-2 text-sm text-sell">{msg}</p>}
      </Confirm>
    </Card>
  );
}

const WATCH = ["status", "outcome", "sl", "tp1_hit_at", "tp2_hit_at", "tp3_hit_at", "commission", "swap", "notes", "lot", "price"];
function describeDiff(e: EventRow): string {
  if (!e.before && e.after) {
    if (e.action.startsWith("partial")) return `${e.after.lot} lot @ ${e.after.price}`;
    return "";
  }
  if (!e.before || !e.after) return "";
  const parts: string[] = [];
  for (const k of WATCH) {
    if (JSON.stringify(e.before[k]) !== JSON.stringify(e.after[k])) {
      const v = (x: unknown) => (x == null ? "—" : typeof x === "string" && x.length > 30 ? x.slice(0, 30) + "…" : String(x));
      parts.push(`${k}: ${v(e.before[k])} → ${v(e.after[k])}`);
    }
  }
  return parts.join("; ");
}
