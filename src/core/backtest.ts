import type { Candle, Timeframe } from "./types.ts";
import { TF_SECONDS } from "./types.ts";
import { analyzeMarket } from "./analysis.ts";
import { detectAll, type SetupCandidate } from "./strategies.ts";
import { dedupeBatch } from "./setups.ts";
import { pipsToPrice, type InstrumentSpec } from "./instrument.ts";
import type { EngineConfig } from "./config.ts";

/**
 * Backtest walk-forward untuk menghitung PROBABILITAS historis (terpisah dari skor kualitas).
 *
 * Definisi:
 *  - P(entry): peluang harga menyentuh entry sebelum setup kedaluwarsa/invalid.
 *  - P(TPk): peluang TPk tersentuh sebelum SL SETELAH entry aktif.
 *
 * Anti look-ahead: pada setiap waktu t, analisis hanya melihat candle yang
 * tertutup ≤ t (sliceClosed). Simulasi hasil memakai bar SESUDAH t.
 *
 * Biaya: entry digeser melawan posisi sebesar spread/2 + slippage; komisi
 * dikonversi ke pips. Bila SL dan TP tersentuh dalam bar yang sama tanpa data
 * lebih rinci, hasil ditandai AMBIGU dan dihitung KONSERVATIF sebagai SL.
 *
 * Pemisahan data: urutan kronologis; `devRatio` awal = pengembangan, sisanya =
 * pengujian (out-of-sample). Probabilitas yang ditampilkan berasal dari data uji.
 */
export interface BacktestOptions {
  spreadPips: number;
  slippagePips: number;
  commissionPips: number;
  devRatio: number;
  /** jumlah bar maksimum per TF yang dilihat analisis pada tiap langkah */
  window: number;
  minSamples: number;
}

export const DEFAULT_BT: BacktestOptions = {
  spreadPips: 3,
  slippagePips: 1,
  commissionPips: 0,
  devRatio: 0.6,
  window: 260,
  minSamples: 30,
};

export interface SimOutcome {
  setup: SetupCandidate;
  entryTouched: boolean;
  invalidBeforeEntry: boolean;
  tp: [boolean | null, boolean | null, boolean | null]; // null = tidak tuntas (data habis)
  ambiguous: boolean;
}

/** Candle tertutup ≤ t, maksimal `window` bar terakhir. */
export function sliceClosed(candles: Candle[], tf: Timeframe, tSec: number, window: number): Candle[] {
  let lo = 0;
  let hi = candles.length;
  const limit = tSec - TF_SECONDS[tf];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time <= limit) lo = mid + 1;
    else hi = mid;
  }
  return candles.slice(Math.max(0, lo - window), lo);
}

export function simulate(
  s: SetupCandidate,
  future: Candle[],
  spec: InstrumentSpec,
  o: BacktestOptions,
): SimOutcome {
  const sign = s.direction === "BUY" ? 1 : -1;
  const out: SimOutcome = { setup: s, entryTouched: false, invalidBeforeEntry: false, tp: [null, null, null], ambiguous: false };
  const step = future.length > 1 ? future[1].time - future[0].time : 300;
  let i = 0;
  let fillIdx = -1;
  if (s.entryType === "market") {
    fillIdx = 0;
  } else {
    for (; i < future.length; i++) {
      const c = future[i];
      if (c.time >= s.expiresAt) break;
      const wantsUp = (s.entryType === "stop") === (s.direction === "BUY");
      const hit = wantsUp ? c.high >= s.entry : c.low <= s.entry;
      if (hit) {
        fillIdx = i;
        break;
      }
      if (c.time + step <= s.expiresAt && sign * (c.close - s.invalidation) <= 0) {
        out.invalidBeforeEntry = true;
        return out;
      }
    }
  }
  if (fillIdx < 0) return out;
  out.entryTouched = true;
  const costPrice = pipsToPrice(o.spreadPips / 2 + o.slippagePips + o.commissionPips, spec);
  const fill = s.entry + sign * costPrice; // harga efektif lebih buruk
  const sl = s.sl;
  const tps = [s.tp1, s.tp2, s.tp3];
  const done: (boolean | null)[] = [null, null, null];
  for (let j = fillIdx; j < future.length; j++) {
    const c = future[j];
    const slHit = sign > 0 ? c.low <= sl : c.high >= sl;
    for (let k = 0; k < 3; k++) {
      if (done[k] !== null) continue;
      // TP efektif harus menutup biaya: target diukur dari harga fill
      const tpHit = sign > 0 ? c.high >= tps[k] + (fill - s.entry) : c.low <= tps[k] + (fill - s.entry);
      if (tpHit && slHit) {
        out.ambiguous = true;
        done[k] = false; // konservatif
      } else if (tpHit) done[k] = true;
      else if (slHit) done[k] = false;
    }
    if (slHit) break;
    if (done.every((d) => d !== null)) break;
  }
  out.tp = done as SimOutcome["tp"];
  return out;
}

export interface Proportion {
  successes: number;
  n: number;
  p: number | null;
  lo: number | null;
  hi: number | null;
}

/** Interval Wilson 95%. */
export function wilson(successes: number, n: number, z = 1.96): Proportion {
  if (n === 0) return { successes, n, p: null, lo: null, hi: null };
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { successes, n, p, lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

export interface ProbabilitySet {
  setups: number;
  entry: Proportion;
  tp1: Proportion;
  tp2: Proportion;
  tp3: Proportion;
  ambiguous: number;
}

export interface BacktestReport {
  key: string;
  periodFrom: number;
  periodTo: number;
  splitAt: number;
  dev: ProbabilitySet;
  test: ProbabilitySet;
  sufficient: boolean;
  options: BacktestOptions;
}

function summarize(outcomes: SimOutcome[]): ProbabilitySet {
  const touched = outcomes.filter((o) => o.entryTouched);
  const tp = (k: 0 | 1 | 2) => {
    const resolved = touched.filter((o) => o.tp[k] !== null);
    return wilson(resolved.filter((o) => o.tp[k] === true).length, resolved.length);
  };
  return {
    setups: outcomes.length,
    entry: wilson(touched.length, outcomes.length),
    tp1: tp(0),
    tp2: tp(1),
    tp3: tp(2),
    ambiguous: outcomes.filter((o) => o.ambiguous).length,
  };
}

/**
 * Jalankan walk-forward. Kunci laporan: "all" dan "<strategi>|<TF>".
 * Setiap langkah = penutupan bar TF konteks.
 */
export function runBacktest(
  candles: Partial<Record<Timeframe, Candle[]>>,
  cfg: EngineConfig,
  o: BacktestOptions = DEFAULT_BT,
): BacktestReport[] {
  const outcomes: SimOutcome[] = [];
  const tfs: Timeframe[] = ["H4", "H1", "M15", "M5"];
  const cfgBt: EngineConfig = { ...cfg };
  for (const pair of cfg.pairs) {
    const ctx = candles[pair.context] ?? [];
    const conf = candles[pair.confirm] ?? [];
    if (ctx.length < 100 || conf.length < 100) continue;
    const pairCfg: EngineConfig = { ...cfgBt, pairs: [pair] };
    const recent: SetupCandidate[] = [];
    for (let i = 60; i < ctx.length; i++) {
      const t = ctx[i].time + TF_SECONDS[pair.context];
      const view: Partial<Record<Timeframe, Candle[]>> = {};
      for (const tf of new Set([...tfs, pair.context, pair.confirm])) {
        view[tf] = sliceClosed(candles[tf] ?? [], tf, t, o.window);
      }
      const confView = view[pair.confirm]!;
      if (confView.length < 3) continue;
      const analysis = analyzeMarket({ nowSec: t, candles: view }, [...new Set([...tfs, pair.context, pair.confirm])]);
      const price = confView[confView.length - 1].close;
      const cands = dedupeBatch(
        detectAll({ analysis, candles: view, price, spreadPips: o.spreadPips, nowSec: t, dataTime: t, config: pairCfg }),
        pairCfg,
      ).filter((c) => c.eligible);
      for (const c of cands) {
        const dup = recent.some(
          (r) =>
            r.identityKey === c.identityKey ||
            (r.strategy === c.strategy && r.direction === c.direction && t < r.expiresAt && Math.abs(r.entry - c.entry) < pipsToPrice(cfg.dedupePips, cfg.spec)),
        );
        if (dup) continue;
        recent.push(c);
        const future = conf.filter((b) => b.time >= t);
        outcomes.push(simulate(c, future, cfg.spec, o));
      }
    }
  }
  if (outcomes.length === 0) return [];
  outcomes.sort((a, b) => a.setup.createdAt - b.setup.createdAt);
  const from = outcomes[0].setup.createdAt;
  const to = outcomes[outcomes.length - 1].setup.createdAt;
  const splitIdx = Math.floor(outcomes.length * o.devRatio);
  const splitAt = outcomes[Math.min(splitIdx, outcomes.length - 1)].setup.createdAt;
  const groups = new Map<string, SimOutcome[]>([["all", outcomes]]);
  for (const oc of outcomes) {
    const k = `${oc.setup.strategy}|${oc.setup.timeframe}`;
    groups.set(k, [...(groups.get(k) ?? []), oc]);
  }
  return [...groups.entries()].map(([key, list]) => {
    const dev = list.filter((x) => x.setup.createdAt < splitAt);
    const test = list.filter((x) => x.setup.createdAt >= splitAt);
    const testSum = summarize(test);
    return {
      key,
      periodFrom: from,
      periodTo: to,
      splitAt,
      dev: summarize(dev),
      test: testSum,
      sufficient: testSum.entry.n >= o.minSamples && testSum.tp1.n >= o.minSamples,
      options: o,
    };
  });
}
