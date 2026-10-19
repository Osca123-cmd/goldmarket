"use client";

import { useMemo, useState } from "react";
import { cx, fmt } from "./ui";
import { computeSignalStats } from "@/core/signalStats";
import { periodStart, type PerfPeriod } from "@/core/delivery";
import type { SetupRow } from "@/lib/market";

const PERIODS: { key: PerfPeriod; label: string }[] = [
  { key: "day", label: "Day" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
  { key: "all", label: "All" },
];

const signedPips = (v: number) => (Math.abs(v) < 0.05 ? "0" : `${v > 0 ? "+" : ""}${fmt(v, 1)}`);

/** Ringkasan hasil sinyal per periode (Day = hari trading sejak reset 23.10 WIB). Data tidak pernah dihapus. */
export function OverallPerformance({ history, tz, now }: { history: SetupRow[]; tz: string; now: number }) {
  const [period, setPeriod] = useState<PerfPeriod>("week");
  const nowSec = Math.floor(now / 1000);
  const from = periodStart(period, nowSec);
  const s = useMemo(
    () =>
      computeSignalStats(
        history.filter((h) => {
          if (h.outcome == null || h.outcome === "open") return true; // sinyal berjalan selalu dihitung sebagai "masih berjalan"
          const at = h.outcome_at ?? h.entry_touched_at;
          return at != null && Date.parse(at) / 1000 >= from;
        }),
        tz,
      ),
    [history, from, tz],
  );
  const decided = s.wins + s.losses;
  const wr = s.winRate;
  const R = 52;
  const C = 2 * Math.PI * R;
  const rows: { label: string; value: number; dot: string }[] = [
    { label: "TP Hits", value: s.wins, dot: "bg-buy" },
    { label: "Break-Even", value: s.be, dot: "bg-muted" },
    { label: "Stop Loss", value: s.losses, dot: "bg-sell" },
    ...(s.timeouts ? [{ label: "Timeout (24 jam)", value: s.timeouts, dot: "bg-warn" }] : []),
  ];
  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-surface fade-in" aria-label="Overall performance">
      <header className="flex items-center gap-2 border-b border-line px-4 py-3 sm:px-5">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted" aria-hidden>
          <path d="M5 20V10M12 20V4M19 20v-7" />
        </svg>
        <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-ink/80">Overall Performance</h2>
      </header>
      <div className="flex flex-wrap gap-2 border-b border-line px-4 py-3 sm:px-5" role="tablist">
        {PERIODS.map((p) => (
          <button
            key={p.key}
            role="tab"
            aria-selected={period === p.key}
            onClick={() => setPeriod(p.key)}
            className={cx("rounded-full border px-4 py-1.5 text-sm font-semibold", period === p.key ? "border-gold/60 bg-gold/15 text-gold" : "border-line text-muted hover:text-ink")}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="space-y-4 px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-center gap-5">
          <svg viewBox="0 0 120 120" className="h-28 w-28 shrink-0" role="img" aria-label={`Win rate ${wr == null ? "belum ada" : `${fmt(wr * 100, 0)}%`}`}>
            <circle cx="60" cy="60" r={R} fill="none" stroke="var(--color-line)" strokeWidth="9" />
            {wr != null && wr > 0 && (
              <circle cx="60" cy="60" r={R} fill="none" stroke="var(--color-gold)" strokeWidth="9" strokeLinecap="round" strokeDasharray={`${C * wr} ${C}`} transform="rotate(-90 60 60)" />
            )}
            <text x="60" y="60" textAnchor="middle" className="num fill-ink text-[22px] font-bold">
              {wr == null ? "—" : `${fmt(wr * 100, 0)}%`}
            </text>
            <text x="60" y="78" textAnchor="middle" className="fill-muted text-[8px] font-semibold uppercase tracking-[0.15em]">
              win rate
            </text>
          </svg>
          <ul className="min-w-[10rem] flex-1 space-y-2 text-sm">
            {rows.map((r) => (
              <li key={r.label} className="flex items-center gap-2">
                <span className={cx("h-2.5 w-2.5 rounded-full", r.dot)} aria-hidden />
                <span className="text-ink/90">{r.label}</span>
                <span className="num ml-auto font-bold text-ink">{r.value}</span>
              </li>
            ))}
          </ul>
        </div>
        <p className="border-t border-line pt-3 text-xs text-muted">
          {s.closed} sinyal tercatat{s.running ? ` · ${s.running} masih berjalan` : ""}
          {s.excluded ? ` · ${s.excluded} dikecualikan tidak dihitung` : ""}
        </p>
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: "Total Signals", value: String(s.closed), tone: "text-ink" },
            { label: "Win Rate", value: decided ? `${fmt((s.wins / decided) * 100, 1)}%` : "—", tone: "text-buy" },
            { label: "Net Pips", value: signedPips(s.totalPips), tone: s.totalPips >= 0 ? "text-gold" : "text-sell" },
          ].map((b) => (
            <div key={b.label} className="min-w-0 rounded-xl border border-line bg-surface-2/50 px-2 py-3 text-center">
              <div className="text-[10px] font-semibold uppercase leading-tight tracking-wider text-muted">{b.label}</div>
              <div className={cx("num mt-1 truncate text-lg font-bold", b.tone)}>{b.value}</div>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-muted">Hasil level sinyal menurut feed, belum termasuk spread/komisi; bukan transaksi Anda. Day = sejak reset 23.10 WIB.</p>
      </div>
    </section>
  );
}
