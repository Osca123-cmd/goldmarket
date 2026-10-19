"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { AppShell } from "@/components/Shell";
import { useMarket } from "@/components/MarketContext";
import { SetupCard } from "@/components/SetupCard";
import { HistoryPanel, SignalHistoryItem, relTime } from "@/components/SignalHistory";
import { PushToggle } from "@/components/PushToggle";
import { Disclaimer, Empty, cx, fmt, useNow } from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { effectiveStatus, isActiveSignal, isRunningSignal, useSignalHistory, type AnalysisRow, type Snapshot } from "@/lib/market";
import { OPPORTUNITY_STATUS_LABEL } from "@/core/setups";
import { STRATEGY_LABEL } from "@/core/config";
import { gradeOf } from "@/core/outcome";
import type { FeedStatus, OpportunityStatus } from "@/core/types";

export default function Page() {
  return (
    <AppShell>
      <LiveSignal />
    </AppShell>
  );
}

const SESSION_LABEL: Record<string, string> = { asia: "Asia", london: "London", newyork: "New York", off: "Di luar sesi" };

type Monitor = { label: string; tone: "live" | "warn" | "off" | "bad" | "demo"; active: boolean };

function monitorState(feed: FeedStatus, analysis: AnalysisRow | null, now: number): Monitor {
  const fresh = analysis ? now - Date.parse(analysis.created_at) < 180_000 : false;
  if (!fresh) return { label: "Engine tidak merespons", tone: "bad", active: false };
  switch (feed) {
    case "live":
      return { label: "Live Monitoring Active", tone: "live", active: true };
    case "delayed":
      return { label: "Monitoring Active · data delayed", tone: "warn", active: true };
    case "demo":
      return { label: "Demo Monitoring (data simulasi)", tone: "demo", active: true };
    case "market_closed":
      return { label: "Market Closed · monitoring dijeda", tone: "off", active: false };
    case "reconnecting":
      return { label: "Reconnecting…", tone: "warn", active: false };
    default:
      return { label: "Disconnected", tone: "bad", active: false };
  }
}

const TONE: Record<Monitor["tone"], string> = {
  live: "border-buy/40 bg-buy/10 text-buy",
  warn: "border-warn/40 bg-warn/10 text-warn",
  off: "border-line bg-surface-2 text-muted",
  bad: "border-sell/40 bg-sell/10 text-sell",
  demo: "border-info/40 bg-info/10 text-info",
};

function MonitorBadge({ m, big }: { m: Monitor; big?: boolean }) {
  return (
    <span className={cx("inline-flex items-center gap-2 rounded-full border font-mono font-semibold", TONE[m.tone], big ? "px-5 py-2.5 text-sm" : "px-3 py-1.5 text-xs")}>
      <span className="relative flex h-2 w-2">
        {m.active && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />}
        <span className="relative inline-flex h-2 w-2 rounded-full bg-current" />
      </span>
      {m.label}
    </span>
  );
}

function LiveIcon({ active }: { active: boolean }) {
  return (
    <div className="relative mx-auto grid h-24 w-24 place-items-center" aria-hidden>
      {active && <span className="ping-ring absolute inset-2 rounded-full border-2 border-gold/50" />}
      <svg width="72" height="72" viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" className={active ? "text-gold" : "text-muted"}>
        <path className={cx(active && "wave wave-3")} d="M8 26c13-12 35-12 48 0" />
        <path className={cx(active && "wave wave-2")} d="M17 35c8-7 22-7 30 0" />
        <path className={cx(active && "wave wave-1")} d="M26 44c3.5-3 8.5-3 12 0" />
        <circle cx="32" cy="53" r="3.5" fill="currentColor" stroke="none" />
      </svg>
    </div>
  );
}

interface Zone {
  low: number;
  high: number;
  label: string;
  dist: number;
  kind: "support" | "resistance";
}

function zones(analysis: AnalysisRow | null, price: number | null, pipSize: number): { dir: "BUY" | "SELL" | null; list: Zone[] } {
  if (!analysis || price == null) return { dir: null, list: [] };
  const atr = analysis.timeframes.M15?.atr ?? 2;
  const pad = Math.max(atr * 0.15, pipSize * 5);
  const all: Zone[] = analysis.levels.map((l) => {
    const low = l.price - pad;
    const high = l.price + pad;
    return {
      low,
      high,
      label: `${l.price > price ? "Resistance" : "Support"} ${l.tf} · ${l.touches}× sentuhan`,
      // jarak harga ke tepi zona terdekat (0 bila harga sudah di dalam zona)
      dist: Math.max(0, price < low ? low - price : price - high) / pipSize,
      kind: l.price > price ? "resistance" : "support",
    };
  });
  const dir = analysis.main_bias === "bullish" ? "BUY" : analysis.main_bias === "bearish" ? "SELL" : null;
  const want = dir === "BUY" ? ["support"] : dir === "SELL" ? ["resistance"] : ["support", "resistance"];
  const list = all.filter((z) => want.includes(z.kind)).sort((a, b) => a.dist - b.dist);
  // gabungkan zona yang tumpang tindih
  const merged: Zone[] = [];
  for (const z of list) if (!merged.some((m) => z.low <= m.high && z.high >= m.low)) merged.push(z);
  return { dir, list: merged.slice(0, 2) };
}

function Watching({ analysis, snapshot, pipSize }: { analysis: AnalysisRow | null; snapshot: Snapshot | null; pipSize: number }) {
  const price = snapshot?.price ?? null;
  const { dir, list } = zones(analysis, price, pipSize);
  return (
    <div className="rounded-2xl border border-line bg-surface-2/40 p-4 text-left sm:p-5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Engine memantau</span>
        <span className="rounded-md border border-gold/30 bg-gold/10 px-2 py-0.5 text-[11px] font-semibold text-gold">GOLDMARKET Engine</span>
      </div>
      <div className="mt-3 flex flex-wrap items-baseline gap-2">
        {dir ? (
          <span className={cx("text-2xl font-extrabold", dir === "BUY" ? "text-buy" : "text-sell")}>{dir === "BUY" ? "▲ Bias BUY" : "▼ Bias SELL"}</span>
        ) : (
          <span className="text-2xl font-extrabold text-muted">◆ NETRAL</span>
        )}
        <span className="text-sm text-muted">
          {analysis ? (dir ? `tren MTF ${analysis.strong_bias ? "searah (H1+M30)" : "moderat (M30)"}` : "pasar ranging · menunggu arah") : "menunggu analisis"}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted">
        {price != null && <>Harga sekarang <span className="num font-semibold text-ink">{fmt(price)}</span> · </>}
        {dir === "BUY" ? "menunggu harga turun ke zona support" : dir === "SELL" ? "menunggu harga naik ke zona resistance" : "menunggu harga mendekati zona"} · belum ada sinyal entry
      </p>
      <div className="mt-3 divide-y divide-line/70 border-t border-line/70">
        {[0, 1].map((i) => {
          const z = list[i];
          return (
            <div key={i} className="flex items-start justify-between gap-3 py-3">
              <div className="min-w-0">
                <div className="text-sm text-ink">{i === 0 ? "🎯 Zona terdekat" : "📍 Zona berikutnya"}</div>
                <div className="truncate text-xs text-gold/90">{z ? z.label : "Belum ada level ≥2 sentuhan di dekat harga"}</div>
              </div>
              <div className="shrink-0 text-right">
                <div className={cx("num text-sm font-bold", z ? (z.kind === "resistance" ? "text-sell" : "text-buy") : "text-muted")}>{z ? `${fmt(z.low)} – ${fmt(z.high)}` : "—"}</div>
                <div className="num text-xs text-muted">
                  {z ? (z.dist === 0 ? "harga di dalam zona" : `${fmt(z.dist, 0)} pips · $${fmt(z.dist * pipSize, 1)} ${z.kind === "support" ? "di bawah" : "di atas"} harga`) : ""}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-[11px] text-muted">Zona dari level S/R (swing ≥2 sentuhan) M15/H1. Ini area pantauan, bukan sinyal entry.</p>
    </div>
  );
}

function LiveSignal() {
  const { setups, snapshot, analysis } = useMarket();
  const { settings } = useAuth();
  const history = useSignalHistory(100);
  const now = useNow(1000);
  const tz = settings?.display_tz ?? "Asia/Jakarta";
  const feed = effectiveStatus(snapshot, now);
  const mon = monitorState(feed, analysis, now);
  const [explain, setExplain] = useState(false);
  const [f, setF] = useState({ dir: "", tf: "", strategy: "", minScore: "", session: "", status: "active", eligible: "yes" });

  const list = useMemo(
    () =>
      setups.filter((s) => {
        if (f.dir && s.direction !== f.dir) return false;
        if (f.tf && s.timeframe !== f.tf) return false;
        if (f.strategy && s.strategy !== f.strategy) return false;
        const min = f.minScore === "" ? (settings?.min_score?.[s.timeframe] ?? 60) : Number(f.minScore);
        if (s.score < min && !isRunningSignal(s)) return false; // sinyal berjalan selalu tampil
        if (f.session && (s.session ?? "off") !== f.session) return false;
        if (f.status === "active" && !isActiveSignal(s)) return false;
        if (f.status && f.status !== "active" && f.status !== "all" && s.status !== f.status) return false;
        if (f.eligible === "yes" && !s.eligible) return false;
        if (f.eligible === "no" && s.eligible) return false;
        return true;
      }),
    [setups, f, settings],
  );
  const hist = history.data ?? [];
  const closed = hist.filter((h) => h.outcome === "win" || h.outcome === "loss");
  const wins = closed.filter((h) => h.outcome === "win").length;
  const runningCount = hist.filter((h) => isRunningSignal(h)).length;
  const totalPips = hist.reduce((a, h) => a + (h.outcome !== "open" ? (h.outcome_pips ?? 0) : 0), 0);

  const title =
    feed === "market_closed" ? "Pasar Sedang Tutup" : analysis && !analysis.quality_ok ? "Sinyal Dijeda — Data Belum Valid" : !mon.active ? "Monitoring Terganggu" : "Menunggu Konfirmasi";

  const sel = (key: keyof typeof f, label: string, opts: [string, string][]) => (
    <label className="min-w-0">
      <span className="label">{label}</span>
      <select className="input" value={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.value })}>
        {opts.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="space-y-4">
      <section className="overflow-hidden rounded-2xl border border-line bg-surface fade-in">
        <header className="flex items-center gap-2 border-b border-line px-4 py-3 sm:px-5">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gold" aria-hidden>
            <circle cx="12" cy="12" r="9" />
            <circle cx="12" cy="12" r="4.5" />
            <circle cx="12" cy="12" r="1" fill="currentColor" />
          </svg>
          <h1 className="text-xs font-bold uppercase tracking-[0.2em] text-ink/80">Live Signal</h1>
        </header>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-4 sm:px-6">
          <span className="rounded-full bg-gradient-to-r from-gold-strong to-gold-deep px-5 py-2 text-sm font-extrabold tracking-wide text-bg shadow-[0_0_24px_rgba(232,184,76,.35)]">INTRADAY · M15 / M30</span>
          <MonitorBadge m={mon} />
        </div>

        {list.length === 0 || f.status !== "active" ? (
          <div className="px-4 py-8 text-center sm:px-8">
            <LiveIcon active={mon.active} />
            <h2 className="mt-3 text-xl font-bold">{title}</h2>
            <p className="mx-auto mt-2 max-w-lg text-sm text-muted">
              Sistem memantau chart <span className="font-semibold text-gold">H1, M30 &amp; M15</span> secara terus-menerus.
              <br className="hidden sm:inline" /> Sinyal muncul otomatis saat setup valid terbentuk — tanpa sinyal paksaan.
            </p>
            <div className="mt-5">
              <MonitorBadge m={mon} big />
            </div>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <button className="btn-ghost" onClick={() => setExplain((x) => !x)} aria-expanded={explain}>
                🧠 Pahami analisis
              </button>
              <Link className="btn-ghost" href="/chart/">
                📈 Lihat chart zona
              </Link>
            </div>
            {explain && analysis && (
              <div className="mx-auto mt-4 max-w-xl rounded-xl border border-line bg-surface-2/50 p-4 text-left text-xs">
                {!analysis.quality_ok && (
                  <ul className="mb-2 space-y-1 text-warn">
                    {analysis.quality_reasons.map((r, i) => (
                      <li key={i}>• {r}</li>
                    ))}
                  </ul>
                )}
                <ul className="space-y-1 text-ink/85">
                  {analysis.reasons.map((r, i) => (
                    <li key={i}>• {r}</li>
                  ))}
                </ul>
                <div className="mt-2 grid grid-cols-3 gap-1">
                  {(["H1", "M30", "M15"] as const).map((tf) => (
                    <span key={tf} className="rounded-lg bg-surface px-2 py-1">
                      <strong>{tf}</strong> <span className={analysis.timeframes[tf]?.bias === "bullish" ? "text-buy" : analysis.timeframes[tf]?.bias === "bearish" ? "text-sell" : "text-muted"}>{analysis.timeframes[tf]?.bias ?? "—"}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
            <div className="mx-auto mt-6 max-w-2xl">
              <Watching analysis={analysis} snapshot={snapshot} pipSize={settings?.pip_size ?? 0.1} />
            </div>
          </div>
        ) : (
          <div className="space-y-3 p-3 sm:p-5">
            <div className="flex items-center gap-3">
              <LiveIconSmall />
              <span className="text-sm font-semibold">{list.length} sinyal aktif · diperbarui realtime</span>
            </div>
            {list.map((s) => (
              <SetupCard key={s.id} s={s} price={snapshot?.price ?? null} tz={tz} now={now} minScore={settings?.min_score?.[s.timeframe]} pipSize={settings?.pip_size} />
            ))}
          </div>
        )}
      </section>

      <PushToggle variant="banner" />

      <details className="card">
        <summary className="cursor-pointer text-sm font-semibold">Filter & semua peluang</summary>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          {sel("dir", "Arah", [["", "Semua"], ["BUY", "BUY"], ["SELL", "SELL"]])}
          {sel("tf", "Timeframe", [["", "Semua"], ["M15", "M15"], ["H1", "H1"]])}
          {sel("strategy", "Strategi", [["", "Semua"], ...Object.entries(STRATEGY_LABEL)])}
          {sel("minScore", "Skor minimum", [["", "Sesuai pengaturan"], ["0", "0"], ["40", "40"], ["50", "50"], ["60", "60"], ["70", "70"], ["80", "80"]])}
          {sel("session", "Sesi", [["", "Semua"], ...Object.entries(SESSION_LABEL)])}
          {sel("status", "Status", [["active", "Aktif"], ["all", "Semua"], ...(Object.entries(OPPORTUNITY_STATUS_LABEL) as [OpportunityStatus, string][])])}
          {sel("eligible", "Kelayakan", [["yes", "Layak saja"], ["no", "Tidak layak saja"], ["", "Semua"]])}
        </div>
        {f.status !== "active" && (
          <div className="mt-3 space-y-3">
            {list.length === 0 ? <Empty title="Tidak ada peluang yang cocok">Ubah filter.</Empty> : list.map((s) => <SetupCard key={s.id} s={s} price={snapshot?.price ?? null} tz={tz} now={now} minScore={settings?.min_score?.[s.timeframe]} pipSize={settings?.pip_size} />)}
          </div>
        )}
      </details>

      <HistoryPanel
        title="Signal History"
        summary={
          closed.length || runningCount ? (
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
              <span>
                Berjalan <strong className="num text-info">{runningCount}</strong>
              </span>
              <span>
                Selesai <strong className="num text-ink">{closed.length}</strong>
              </span>
              <span>
                Win rate <strong className="num text-ink">{closed.length ? `${fmt((wins / closed.length) * 100, 0)}%` : "—"}</strong> ({wins}W/{closed.length - wins}L)
              </span>
              <span>
                Total <strong className={cx("num", totalPips >= 0 ? "text-buy" : "text-sell")}>{totalPips >= 0 ? "+" : ""}{fmt(totalPips, 1)} pips</strong>
              </span>
              {closed.length < 30 && <span className="text-warn">Sampel kecil — belum stabil</span>}
            </div>
          ) : undefined
        }
      >
        {hist.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted">Belum ada sinyal yang entry-nya tersentuh. Riwayat terisi otomatis dari engine.</p>
        ) : (
          hist.map((h) => (
            <SignalHistoryItem key={h.id} s={h} tz={tz} price={snapshot?.price ?? null} grade={gradeOf(h.score)} time={`${relTime(h.entry_touched_at, now)} · ${STRATEGY_LABEL[h.strategy]}`} />
          ))
        )}
        <p className="px-5 py-3 text-[11px] text-muted">
          Setelah TP1, SL dipindah ke entry (BE). WIN = TP tertinggi yang tersentuh, ditutup saat harga kembali ke entry / TP3 / 24 jam; LOSS = SL sebelum TP1; SL &amp; TP dalam candle yang sama dihitung SL. Hasil level sinyal menurut feed ({snapshot?.source_label ?? "—"}), belum termasuk spread/komisi, dan bukan transaksi Anda. Tidak menjamin hasil mendatang.
        </p>
      </HistoryPanel>
      <Disclaimer />
    </div>
  );
}

function LiveIconSmall() {
  return (
    <svg width="28" height="28" viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round" className="text-gold" aria-hidden>
      <path className="wave wave-3" d="M8 26c13-12 35-12 48 0" />
      <path className="wave wave-2" d="M17 35c8-7 22-7 30 0" />
      <path className="wave wave-1" d="M26 44c3.5-3 8.5-3 12 0" />
      <circle cx="32" cy="53" r="4" fill="currentColor" stroke="none" />
    </svg>
  );
}
