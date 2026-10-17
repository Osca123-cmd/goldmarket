"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmt } from "./ui";

interface Prop {
  successes: number;
  n: number;
  p: number | null;
  lo: number | null;
  hi: number | null;
}
interface ProbRow {
  key: string;
  computed_at: string;
  source: string;
  period_from: string;
  period_to: string;
  split_at: string;
  sufficient: boolean;
  test: { setups: number; entry: Prop; tp1: Prop; tp2: Prop; tp3: Prop; ambiguous: number };
  options: { spreadPips: number; slippagePips: number; commissionPips: number; minSamples: number };
}

const cache = new Map<string, Promise<ProbRow | null>>();
function load(key: string) {
  if (!cache.has(key)) {
    cache.set(
      key,
      Promise.resolve(supabase().from("probability_stats").select("*").eq("key", key).maybeSingle()).then(({ data }) => (data as ProbRow) ?? null),
    );
  }
  return cache.get(key)!;
}

const pct = (x: number | null) => (x == null ? "—" : `${fmt(x * 100, 0)}%`);

/**
 * Probabilitas HANYA dari backtest walk-forward pada data uji (out-of-sample).
 * Jika sampel < minimum, tampilkan pesan bahwa probabilitas belum tersedia.
 */
export function ProbabilityBox({ strategy, timeframe }: { strategy: string; timeframe: string }) {
  const [row, setRow] = useState<ProbRow | null | undefined>(undefined);
  useEffect(() => {
    void load(`${strategy}|${timeframe}`).then(setRow);
  }, [strategy, timeframe]);

  if (row === undefined) return <p className="text-xs text-muted">Memuat validasi historis…</p>;
  if (!row || !row.sufficient) {
    return (
      <div className="rounded-xl border border-line bg-surface-2/50 p-3 text-xs">
        <p className="font-semibold text-ink">Probabilitas belum tersedia — validasi historis belum memadai.</p>
        {row && (
          <p className="mt-1 text-muted">
            Data uji saat ini: {row.test.entry.n} setup, {row.test.tp1.n} entry tuntas (minimum {row.options.minSamples}).
          </p>
        )}
      </div>
    );
  }
  const t = row.test;
  return (
    <div className="rounded-xl border border-line bg-surface-2/50 p-3 text-xs">
      <h4 className="card-title mb-1">Probabilitas historis (data uji)</h4>
      <table className="w-full">
        <tbody>
          <Row label="Entry tersentuh sebelum kedaluwarsa" p={t.entry} />
          <Row label="TP1 sebelum SL (setelah entry)" p={t.tp1} />
          <Row label="TP2 sebelum SL (setelah entry)" p={t.tp2} />
          <Row label="TP3 sebelum SL (setelah entry)" p={t.tp3} />
        </tbody>
      </table>
      <p className="mt-2 text-muted">
        Periode {row.period_from.slice(0, 10)} s/d {row.period_to.slice(0, 10)} (uji mulai {row.split_at.slice(0, 10)}). Interval = Wilson 95%. Biaya: spread {row.options.spreadPips} pips, slippage{" "}
        {row.options.slippagePips} pips. {t.ambiguous} kasus SL & TP dalam candle sama dihitung sebagai SL (konservatif). Sumber: {row.source}. Hasil masa lalu tidak menjamin hasil mendatang.
      </p>
    </div>
  );
}

function Row({ label, p }: { label: string; p: Prop }) {
  return (
    <tr>
      <td className="py-0.5 pr-2">{label}</td>
      <td className="num py-0.5 text-right">
        {pct(p.p)} <span className="text-muted">({pct(p.lo)}–{pct(p.hi)}, n={p.n})</span>
      </td>
    </tr>
  );
}
