"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { AppShell } from "@/components/Shell";
import { useMarket } from "@/components/MarketContext";
import { SetupCard } from "@/components/SetupCard";
import { QUIET_PREFIX, lastResetSec } from "@/core/delivery";
import { OverallPerformance } from "@/components/OverallPerformance";
import { HistoryPanel, SignalHistoryItem, relTime } from "@/components/SignalHistory";
import { PushToggle } from "@/components/PushToggle";
import { Disclaimer, Empty, ago, cx, fmt, useNow } from "@/components/ui";
import { ZoneBar } from "@/components/LevelBar";
import { Mascot, type MascotKind, type MascotMood } from "@/components/Mascot";
import { useAuth } from "@/lib/auth";
import { effectiveStatus, isActiveSignal, isRunningSignal, useSignalHistory, type AnalysisRow } from "@/lib/market";
import { OPPORTUNITY_STATUS_LABEL } from "@/core/setups";
import { RETIRED_STRATEGIES, STRATEGY_LABEL } from "@/core/config";
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

const TREND: Record<string, { word: string; cls: string }> = {
  bullish: { word: "naik", cls: "text-buy" },
  bearish: { word: "turun", cls: "text-sell" },
  ranging: { word: "datar", cls: "text-muted" },
};

const FEED_LINE: Record<FeedStatus, { label: string; pill: string }> = {
  live: { label: "Live", pill: "bg-buy/15 text-buy" },
  delayed: { label: "Data tertunda", pill: "bg-warn/15 text-warn" },
  demo: { label: "Data demo", pill: "bg-info/15 text-info" },
  market_closed: { label: "Pasar tutup", pill: "bg-surface-2 text-muted" },
  reconnecting: { label: "Menyambung ulang", pill: "bg-warn/15 text-warn" },
  disconnected: { label: "Feed terputus", pill: "bg-sell/15 text-sell" },
};

interface Zone {
  low: number;
  high: number;
  mid: number;
  tf: string;
  touches: number;
  dist: number;
  kind: "support" | "resistance";
}

/** Zona S/R di atas (resistance) dan di bawah (support) harga, masing-masing urut dari yang terdekat. */
function zones(analysis: AnalysisRow | null, price: number | null, pipSize: number): { dir: "BUY" | "SELL" | null; support: Zone[]; resistance: Zone[] } {
  if (!analysis || price == null) return { dir: null, support: [], resistance: [] };
  const atr = analysis.timeframes.M15?.atr ?? 2;
  const pad = Math.max(atr * 0.15, pipSize * 5);
  const all: Zone[] = analysis.levels
    .map((l) => {
      const low = l.price - pad;
      const high = l.price + pad;
      return {
        low,
        high,
        mid: l.price,
        tf: l.tf,
        touches: l.touches,
        // jarak harga ke tepi zona terdekat (0 bila harga sudah di dalam zona)
        dist: Math.max(0, price < low ? low - price : price - high) / pipSize,
        kind: (l.price > price ? "resistance" : "support") as Zone["kind"],
      };
    })
    .sort((a, b) => a.dist - b.dist);
  // gabungkan zona yang tumpang tindih
  const merged: Zone[] = [];
  for (const z of all) if (!merged.some((m) => z.low <= m.high && z.high >= m.low)) merged.push(z);
  const dir = analysis.main_bias === "bullish" ? "BUY" : analysis.main_bias === "bearish" ? "SELL" : null;
  return { dir, support: merged.filter((z) => z.kind === "support"), resistance: merged.filter((z) => z.kind === "resistance") };
}

/** Kalimat zona berikutnya di sisi yang searah bias (keduanya bila netral). */
function nextZones(w: ReturnType<typeof zones>): string | null {
  const parts = [
    ...(w.dir !== "BUY" && w.resistance[1] ? [`resistance ${w.resistance[1].tf} ${fmt(w.resistance[1].mid)} (${fmt(w.resistance[1].dist, 0)} pips)`] : []),
    ...(w.dir !== "SELL" && w.support[1] ? [`support ${w.support[1].tf} ${fmt(w.support[1].mid)} (${fmt(w.support[1].dist, 0)} pips)`] : []),
  ];
  return parts.length ? `Zona berikutnya: ${parts.join(" dan ")}.` : null;
}

function LiveSignal() {
  const { setups, snapshot, analysis } = useMarket();
  const { settings } = useAuth();
  const history = useSignalHistory(1000);
  const now = useNow(1000);
  const tz = settings?.display_tz ?? "Asia/Jakarta";
  const feed = effectiveStatus(snapshot, now);
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
  // strategi aktif dulu; yang sudah dimatikan hanya muncul bila masih ada setup lamanya
  const strategyOptions = useMemo(() => {
    const present = new Set(setups.map((s) => s.strategy));
    const entries = Object.entries(STRATEGY_LABEL) as [keyof typeof STRATEGY_LABEL, string][];
    return [
      ...entries.filter(([k]) => !RETIRED_STRATEGIES.includes(k)),
      ...entries.filter(([k]) => RETIRED_STRATEGIES.includes(k) && present.has(k)).map(([k, v]) => [k, `${v} · nonaktif`] as [typeof k, string]),
    ];
  }, [setups]);
  const allHist = history.data ?? [];
  // reset tampilan harian 23.10 WIB: hanya sinyal hari trading berjalan + yang masih berjalan (data tetap tersimpan)
  const resetAt = lastResetSec(Math.floor(now / 1000)) * 1000;
  const hist = allHist.filter((h) => isRunningSignal(h) || (h.entry_touched_at != null && Date.parse(h.entry_touched_at) >= resetAt));
  const counted = hist.filter((h) => !h.excluded);
  const excludedCount = hist.length - counted.length;
  const closed = counted.filter((h) => h.outcome === "win" || h.outcome === "loss");
  const wins = closed.filter((h) => h.outcome === "win").length;
  const runningCount = counted.filter((h) => isRunningSignal(h)).length;
  const totalPips = counted.reduce((a, h) => a + (h.outcome !== "open" ? (h.outcome_pips ?? 0) : 0), 0);

  const price = snapshot?.price ?? null;
  const pipSize = settings?.pip_size ?? 0.1;
  const fresh = analysis ? now - Date.parse(analysis.created_at) < 180_000 : false;
  const showSignals = list.length > 0 && f.status === "active";
  const watch = zones(analysis, price, pipSize);
  const quietLine = analysis?.reasons?.[0]?.startsWith(QUIET_PREFIX) ? analysis.reasons[0] : null;
  const feedLine = quietLine && feed !== "market_closed" ? { label: "Jam istirahat", pill: "bg-surface-2 text-muted" } : fresh ? FEED_LINE[feed] : { label: "Engine tidak merespons", pill: "bg-sell/15 text-sell" };
  // banteng = mencari BUY, beruang = mencari SELL, keduanya = belum ada arah / sinyal dua arah
  const dirs = new Set(showSignals ? list.map((x) => x.direction) : watch.dir ? [watch.dir] : []);
  const mascot: MascotKind = dirs.size === 1 ? (dirs.has("BUY") ? "bull" : "bear") : "both";
  const mood: MascotMood = quietLine || feed === "market_closed" ? "sleep" : fresh && feed === "live" ? "live" : "still";
  const one = list[0];
  const [title, sub] =
    feed === "market_closed"
      ? ["Pasar sedang tutup.", "Pemantauan berlanjut otomatis saat pasar buka."]
      : quietLine
        ? [
            `Jam istirahat sampai ${quietLine.match(/lanjut (\d{2}\.\d{2})/)?.[1] ?? "05.00"} WIB.`,
            "Tidak ada sinyal baru sampai jam itu. Sinyal yang sudah berjalan tetap dipantau, dan analisis chart tetap diperbarui.",
          ]
        : analysis && !analysis.quality_ok
          ? ["Sinyal dijeda karena data belum valid.", analysis.quality_reasons[0] ?? "Engine menunggu data yang lengkap."]
          : !fresh
            ? ["Engine belum mengirim analisis terbaru.", "Halaman ini diperbarui sendiri begitu engine kembali."]
            : showSignals
              ? [
                  list.length === 1 ? `Sinyal ${one.direction} ${one.timeframe} ${isRunningSignal(one) ? "sedang berjalan" : "siap, menunggu entry"}.` : `${list.length} sinyal aktif.`,
                  "Level lengkap ada di bawah. Website ini tidak membuka posisi di broker.",
                ]
              : [
                  watch.dir === "BUY" ? "Engine mencari BUY di support terdekat." : watch.dir === "SELL" ? "Engine mencari SELL di resistance terdekat." : "Pasar datar, engine menunggu harga mendekati zona.",
                  "Belum ada setup yang memenuhi syarat. Sinyal muncul sendiri saat setup valid terbentuk, tanpa sinyal paksaan.",
                ];
  const link = "rounded text-sm font-medium text-gold underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold";

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
        <div className="px-4 pt-5 sm:px-6">
          <div className="flex items-center gap-3">
            <Mascot kind={mascot} mood={mood} />
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 text-base font-bold text-ink">
                {feedLine.label}
                <span className={cx("rounded-full px-2 py-0.5 text-[11px] font-bold", feedLine.pill)}>XAUUSD</span>
              </p>
              <p className="mt-0.5 text-xs text-muted">
                {mascot === "bull" ? "Bias BUY" : mascot === "bear" ? "Bias SELL" : showSignals ? "Sinyal BUY dan SELL" : "Belum ada arah"}
                {analysis ? `, analisis ${ago(analysis.created_at, now)}` : ""}
              </p>
            </div>
          </div>
          <h1 className="mt-3 text-xl font-semibold leading-snug text-ink sm:text-2xl">{title}</h1>
          <p className="mt-1 max-w-prose text-sm text-muted">{sub}</p>
          {analysis && (
            <p className="mt-3 text-sm text-ink/85">
              {/* H4 hanya info & bonus skor, bukan filter sinyal */}
              {(["H4", "H1", "M30", "M15"] as const)
                .filter((tf) => tf !== "H4" || analysis.timeframes.H4)
                .map((tf, i) => {
                  const t = TREND[analysis.timeframes[tf]?.bias ?? ""] ?? { word: "belum ada data", cls: "text-muted" };
                  return (
                    <span key={tf}>
                      {i > 0 && ", "}
                      {tf} <span className={cx("font-semibold", t.cls)}>{t.word}</span>
                      {tf === "H4" && <span className="text-xs text-muted"> (info)</span>}
                    </span>
                  );
                })}
              .
            </p>
          )}
        </div>

        {showSignals ? (
          <div className="mt-4 divide-y divide-line border-t border-line">
            {list.map((s) => (
              <SetupCard key={s.id} bare s={s} price={price} tz={tz} now={now} minScore={settings?.min_score?.[s.timeframe]} pipSize={settings?.pip_size} />
            ))}
          </div>
        ) : (
          <div className="px-4 pb-4 pt-5 sm:px-6">
            {price != null && <ZoneBar support={watch.support[0] ?? null} resistance={watch.resistance[0] ?? null} price={price} pipSize={pipSize} />}
            <p className="mt-4 text-xs text-muted">
              {nextZones(watch) ? `${nextZones(watch)} ` : ""}Zona dari level support dan resistance M15 dan H1 yang tersentuh minimal dua kali. Ini area pantauan, bukan sinyal entry.
            </p>
          </div>
        )}

        <div className="flex flex-wrap gap-x-5 gap-y-2 border-t border-line px-4 py-3 sm:px-6">
          <button className={link} onClick={() => setExplain((x) => !x)} aria-expanded={explain}>
            {explain ? "Tutup penjelasan" : "Pahami analisis"}
          </button>
          <Link className={link} href="/chart/">
            Buka chart zona
          </Link>
        </div>
        {explain && analysis && (
          <div className="border-t border-line px-4 py-4 text-sm sm:px-6">
            {!analysis.quality_ok && (
              <ul className="mb-3 list-disc space-y-1 pl-4 text-warn">
                {analysis.quality_reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            )}
            <ul className="max-w-prose list-disc space-y-1 pl-4 text-ink/85">
              {analysis.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <PushToggle variant="banner" />

      <details className="card">
        <summary className="cursor-pointer text-sm font-semibold">Cari peluang lain</summary>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          {sel("dir", "Arah", [["", "Semua"], ["BUY", "BUY"], ["SELL", "SELL"]])}
          {sel("tf", "Timeframe", [["", "Semua"], ["M15", "M15"], ["M30", "M30"], ...(setups.some((s) => s.timeframe === "H1") ? [["H1", "H1 (lama)"] as [string, string]] : [])])}
          {sel("strategy", "Strategi", [["", "Semua"], ...strategyOptions])}
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

      <OverallPerformance history={allHist} tz={tz} now={now} />

      <HistoryPanel
        title="Riwayat sinyal hari ini"
        summary={
          closed.length || runningCount ? (
            <p className="text-sm text-muted">
              {runningCount > 0 && <>{runningCount} berjalan, </>}
              {closed.length} selesai
              {closed.length > 0 && (
                <>
                  , win rate <span className="num font-semibold text-ink">{fmt((wins / closed.length) * 100, 0)}%</span> ({wins} menang, {closed.length - wins} kalah)
                </>
              )}
              , total <span className={cx("num font-semibold", totalPips >= 0 ? "text-buy" : "text-sell")}>{totalPips >= 0 ? "+" : ""}{fmt(totalPips, 1)} pips</span>.
              {excludedCount > 0 && <> {excludedCount} dikecualikan.</>}
              {closed.length < 30 && <span className="text-warn"> Sampel masih kecil, belum stabil.</span>}
            </p>
          ) : undefined
        }
      >
        {hist.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted">Belum ada sinyal hari ini. Riwayat direset otomatis pukul 23.10 WIB; riwayat lengkap ada di Jurnal → Sinyal dan panel Kinerja.</p>
        ) : (
          hist.map((h) => (
            <SignalHistoryItem key={h.id} s={h} tz={tz} price={snapshot?.price ?? null} grade={gradeOf(h.score)} time={`${STRATEGY_LABEL[h.strategy]}, entry ${hhmm(h.entry_touched_at, tz)} (${relTime(h.entry_touched_at, now)})`} />
          ))
        )}
        <p className="px-1 pt-2 text-[11px] text-muted">
          Setelah TP1, SL dipindah ke entry (BE). WIN = TP tertinggi yang tersentuh, ditutup saat harga kembali ke entry / TP3 / 24 jam; LOSS = SL sebelum TP1; SL &amp; TP dalam candle yang sama dihitung SL. Hasil level sinyal menurut feed ({snapshot?.source_label ?? "—"}), belum termasuk spread/komisi, dan bukan transaksi Anda. Tidak menjamin hasil mendatang.
        </p>
      </HistoryPanel>
      <Disclaimer />
    </div>
  );
}

function hhmm(iso: string | null, tz: string): string {
  return iso ? new Date(iso).toLocaleTimeString("id-ID", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }) : "—";
}
