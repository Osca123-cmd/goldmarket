"use client";

import { useMemo, useState } from "react";
import { cx, fmt } from "./ui";
import { computeSignalStats } from "@/core/signalStats";
import { periodStart, type PerfPeriod } from "@/core/delivery";
import type { SetupRow } from "@/lib/market";

const PERIODS: { key: PerfPeriod; label: string }[] = [
  { key: "day", label: "Hari ini" },
  { key: "week", label: "Minggu ini" },
  { key: "month", label: "Bulan ini" },
  { key: "all", label: "Semua" },
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
  const total = decided + s.timeouts + s.be;
  const seg = (n: number) => (total ? `${(n / total) * 100}%` : "0%");
  return (
    <section className="rounded-2xl border border-line bg-surface px-4 py-4 fade-in sm:px-5" aria-label="Kinerja sinyal">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <h2 className="mr-auto text-base font-semibold text-ink">Kinerja</h2>
        <div className="flex rounded-lg border border-line p-0.5" role="tablist" aria-label="Periode">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              role="tab"
              aria-selected={period === p.key}
              onClick={() => setPeriod(p.key)}
              className={cx("rounded-md px-2.5 py-1 text-xs font-medium sm:px-3", period === p.key ? "bg-surface-2 text-ink" : "text-muted hover:text-ink")}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 flex h-2 overflow-hidden rounded-full bg-line" role="img" aria-label={`${s.wins} menang, ${s.losses} kalah${s.timeouts ? `, ${s.timeouts} ditutup 24 jam` : ""}${s.be ? `, ${s.be} impas` : ""}`}>
        <span className="h-full bg-buy" style={{ width: seg(s.wins) }} />
        <span className="h-full bg-muted" style={{ width: seg(s.be) }} />
        <span className="h-full bg-warn" style={{ width: seg(s.timeouts) }} />
        <span className="h-full bg-sell" style={{ width: seg(s.losses) }} />
      </div>
      <p className="mt-2 text-sm text-ink/90">
        <span className="font-semibold text-buy">{s.wins} menang</span>, <span className="font-semibold text-sell">{s.losses} kalah</span>
        {s.be ? `, ${s.be} impas` : ""}
        {s.timeouts ? `, ${s.timeouts} ditutup setelah 24 jam` : ""}
      </p>

      <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-line pt-4">
        <div className="min-w-0">
          <dt className="text-xs text-muted">Win rate</dt>
          <dd className="num mt-0.5 text-lg font-bold text-ink">{decided ? `${fmt((s.wins / decided) * 100, 1)}%` : "—"}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-muted">Net pips</dt>
          <dd className={cx("num mt-0.5 text-lg font-bold", s.totalPips >= 0 ? "text-gold" : "text-sell")}>{signedPips(s.totalPips)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-muted">Sinyal selesai</dt>
          <dd className="num mt-0.5 text-lg font-bold text-ink">{s.closed}</dd>
        </div>
      </dl>
      <p className="mt-3 text-xs text-muted">
        {s.running ? `${s.running} sinyal masih berjalan. ` : ""}
        {s.excluded ? `${s.excluded} sinyal dikecualikan tidak dihitung. ` : ""}
        Hasil level sinyal menurut feed, belum termasuk spread atau komisi, dan bukan transaksi Anda. Hari ini dihitung sejak reset 23.10 WIB.
      </p>
    </section>
  );
}
