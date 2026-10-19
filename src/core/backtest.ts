import type { Candle, Timeframe } from "./types.ts";
import { TF_SECONDS } from "./types.ts";
import { analyzeMarket } from "./analysis.ts";
import { detectAll, type SetupCandidate } from "./strategies.ts";
import { dedupeBatch } from "./setups.ts";
import { pipsToPrice, priceToPips, roundToTick, type InstrumentSpec } from "./instrument.ts";
import { sessionAt } from "./sessions.ts";
import { analysisTfs, type EngineConfig } from "./config.ts";
import { setupFeatures, type SetupFeatures } from "./features.ts";

/**
 * Backtest walk-forward: PROBABILITAS historis (terpisah dari skor kualitas) dan
 * perbandingan MANAJEMEN POSISI.
 *
 * Definisi:
 *  - P(entry): peluang harga menyentuh entry sebelum setup kedaluwarsa/invalid.
 *  - P(TPk): peluang TPk tersentuh sebelum SL (dan sebelum batas tahan) SETELAH entry aktif.
 *
 * Anti look-ahead: pada setiap waktu t, analisis hanya melihat candle yang
 * tertutup ≤ t (sliceClosed). Simulasi hasil memakai bar SESUDAH t.
 *
 * Biaya: entry digeser melawan posisi sebesar spread/2 + slippage (+ komisi dalam
 * pips). TP baru dianggap kena bila harga menutup biaya itu (profit = jarak TP
 * penuh); SL kena di levelnya (rugi = jarak SL + biaya). SL dan TP dalam bar yang
 * sama tanpa data lebih rinci → AMBIGU, dihitung KONSERVATIF sebagai SL.
 *
 * Manajemen posisi (P/L per trade dalam pips, posisi dibagi rata per kaki):
 *  - A "TP1 penuh": seluruh posisi keluar di TP1 atau SL.
 *  - B "Bertahap 1/3, SL tetap": 1/3 di TP1, TP2, TP3; sisa kena SL.
 *  - C "Bertahap 1/3 + BE setelah TP1": setelah TP1, SL sisa posisi pindah ke
 *    harga entry (mulai bar BERIKUTNYA — urutan di dalam bar tidak diketahui);
 *    keluar di BE = rugi sebesar biaya.
 *  Posisi yang belum selesai setelah `maxHoldSec` ditutup di close terakhir
 *  (sama dengan batas pelacakan sinyal live).
 *
 * Pemisahan data: urutan kronologis; `devRatio` awal = pengembangan, sisanya =
 * pengujian (out-of-sample). Angka yang ditampilkan berasal dari data uji.
 */
export interface BacktestOptions {
  spreadPips: number;
  slippagePips: number;
  commissionPips: number;
  devRatio: number;
  /** jumlah bar maksimum per TF yang dilihat analisis pada tiap langkah */
  window: number;
  minSamples: number;
  /** batas tahan posisi setelah entry (detik) */
  maxHoldSec: number;
}

export const DEFAULT_BT: BacktestOptions = {
  spreadPips: 3,
  slippagePips: 1,
  commissionPips: 0,
  devRatio: 0.6,
  window: 260,
  minSamples: 30,
  maxHoldSec: 24 * 3600,
};

export type MgmtVariant = "A" | "B" | "C" | "D" | "E" | "F";

/** Level pada kelipatan R (jarak entry–SL) dari entry, searah posisi. */
function atR(s: SetupCandidate, k: number, spec: InstrumentSpec): number {
  const sign = s.direction === "BUY" ? 1 : -1;
  return roundToTick(s.entry + sign * k * Math.abs(s.entry - s.sl), spec);
}

interface VariantDef {
  label: string;
  /** level target tiap kaki (posisi dibagi rata) */
  targets: (s: SetupCandidate, spec: InstrumentSpec) => number[];
  /** SL sisa posisi pindah ke entry setelah target pertama kena */
  be: boolean;
}

/**
 * Varian manajemen posisi yang dibandingkan. D–F menguji TP lebih dekat (dalam R,
 * jadi berlaku proporsional untuk M15 dan H1) — win rate lebih tinggi, tetapi
 * kemenangan lebih kecil; hanya ekspektasi yang menentukan mana yang lebih baik.
 */
export const MGMT_DEFS: Record<MgmtVariant, VariantDef> = {
  A: { label: "TP1 penuh", targets: (s) => [s.tp1], be: false },
  B: { label: "Bertahap 1/3, SL tetap", targets: (s) => [s.tp1, s.tp2, s.tp3], be: false },
  C: { label: "Bertahap 1/3 + BE setelah TP1", targets: (s) => [s.tp1, s.tp2, s.tp3], be: true },
  D: { label: "TP cepat 0,4R (M15 ±20 pips)", targets: (s, spec) => [atR(s, 0.4, spec)], be: false },
  E: { label: "TP cepat 0,6R (M15 ±30 pips)", targets: (s, spec) => [atR(s, 0.6, spec)], be: false },
  F: { label: "1/2 di 0,6R + BE, sisa ke TP2", targets: (s, spec) => [atR(s, 0.6, spec), s.tp2], be: true },
};
export const MGMT_VARIANTS = Object.keys(MGMT_DEFS) as MgmtVariant[];
export const MGMT_LABEL = Object.fromEntries(MGMT_VARIANTS.map((v) => [v, MGMT_DEFS[v].label])) as Record<MgmtVariant, string>;

export interface SimOutcome {
  setup: SetupCandidate;
  entryTouched: boolean;
  invalidBeforeEntry: boolean;
  tp: [boolean | null, boolean | null, boolean | null]; // null = tidak tuntas (data habis)
  ambiguous: boolean;
  /** P/L per varian manajemen (pips, biaya termasuk); null bila entry tidak tersentuh / belum tuntas */
  pips: Record<MgmtVariant, number> | null;
  /** ciri setup saat dibuat (riset filter) */
  features?: SetupFeatures;
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

interface Leg {
  target: number; // level TP (sebelum penyesuaian biaya)
  pnl: number | null;
}

/**
 * Jalankan kaki-kaki posisi dari bar fill. Mengembalikan P/L rata-rata per kaki
 * (pips) atau null bila data habis sebelum semua kaki selesai / batas tahan.
 */
function runLegs(
  s: SetupCandidate,
  bars: Candle[],
  fillIdx: number,
  fill: number,
  targets: number[],
  beAfterTp1: boolean,
  spec: InstrumentSpec,
  maxHoldSec: number,
): { pips: number | null; ambiguous: boolean } {
  const sign = s.direction === "BUY" ? 1 : -1;
  const shift = fill - s.entry; // TP harus menutup biaya
  const pips = (price: number) => priceToPips(sign * (price - fill), spec);
  const legs: Leg[] = targets.map((t) => ({ target: t, pnl: null }));
  let stop = s.sl;
  let beArmed = false;
  let ambiguous = false;
  const fillTime = bars[fillIdx]?.time ?? 0;
  for (let j = fillIdx; j < bars.length; j++) {
    const c = bars[j];
    if (c.time - fillTime >= maxHoldSec) {
      const last = bars[j - 1]?.close ?? c.open;
      for (const l of legs) if (l.pnl === null) l.pnl = pips(last);
      break;
    }
    if (beArmed) stop = s.entry; // BE aktif mulai bar sesudah TP1
    const slHit = sign > 0 ? c.low <= stop : c.high >= stop;
    let tp1Now = false;
    for (let k = 0; k < legs.length; k++) {
      const l = legs[k];
      if (l.pnl !== null) continue;
      const tpHit = sign > 0 ? c.high >= l.target + shift : c.low <= l.target + shift;
      if (tpHit && slHit) {
        ambiguous = true;
        l.pnl = pips(stop);
      } else if (tpHit) {
        l.pnl = pips(l.target + shift);
        if (k === 0) tp1Now = true;
      } else if (slHit) l.pnl = pips(stop);
    }
    if (tp1Now && beAfterTp1) beArmed = true;
    if (legs.every((l) => l.pnl !== null)) break;
  }
  if (legs.some((l) => l.pnl === null)) return { pips: null, ambiguous };
  return { pips: Math.round((legs.reduce((a, l) => a + l.pnl!, 0) / legs.length) * 10) / 10, ambiguous };
}

export function simulate(s: SetupCandidate, future: Candle[], spec: InstrumentSpec, o: BacktestOptions): SimOutcome {
  const sign = s.direction === "BUY" ? 1 : -1;
  const out: SimOutcome = { setup: s, entryTouched: false, invalidBeforeEntry: false, tp: [null, null, null], ambiguous: false, pips: null };
  const step = future.length > 1 ? future[1].time - future[0].time : 300;
  let fillIdx = -1;
  if (s.entryType === "market") {
    fillIdx = future.length ? 0 : -1;
  } else {
    for (let i = 0; i < future.length; i++) {
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
  const tps = [s.tp1, s.tp2, s.tp3];

  // Probabilitas TPk sebelum SL (setiap TP dinilai independen, SL tetap)
  const fillTime = future[fillIdx].time;
  const done: (boolean | null)[] = [null, null, null];
  for (let j = fillIdx; j < future.length; j++) {
    const c = future[j];
    if (c.time - fillTime >= o.maxHoldSec) {
      for (let k = 0; k < 3; k++) if (done[k] === null) done[k] = false; // batas tahan
      break;
    }
    const slHit = sign > 0 ? c.low <= s.sl : c.high >= s.sl;
    for (let k = 0; k < 3; k++) {
      if (done[k] !== null) continue;
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

  const res = MGMT_VARIANTS.map((v) => [v, runLegs(s, future, fillIdx, fill, MGMT_DEFS[v].targets(s, spec), MGMT_DEFS[v].be, spec, o.maxHoldSec)] as const);
  out.ambiguous ||= res.some(([, r]) => r.ambiguous);
  out.pips = res.every(([, r]) => r.pips != null) ? (Object.fromEntries(res.map(([v, r]) => [v, r.pips!])) as Record<MgmtVariant, number>) : null;
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

/** Satu setup hasil simulasi, dalam bentuk ringkas untuk disimpan per potongan. */
export interface BacktestTrade {
  createdAt: number;
  strategy: string;
  timeframe: Timeframe;
  direction: "BUY" | "SELL";
  session: string;
  slPips: number;
  entryTouched: boolean;
  invalidBeforeEntry: boolean;
  tp: [boolean | null, boolean | null, boolean | null];
  ambiguous: boolean;
  pips: Record<MgmtVariant, number> | null;
  features?: SetupFeatures;
}

export function toTrade(o: SimOutcome): BacktestTrade {
  return {
    createdAt: o.setup.createdAt,
    strategy: o.setup.strategy,
    timeframe: o.setup.timeframe,
    direction: o.setup.direction,
    session: sessionAt(o.setup.createdAt * 1000),
    slPips: o.setup.slPips,
    entryTouched: o.entryTouched,
    invalidBeforeEntry: o.invalidBeforeEntry,
    tp: o.tp,
    ambiguous: o.ambiguous,
    pips: o.pips,
    features: o.features,
  };
}

function probabilities(list: Pick<BacktestTrade, "entryTouched" | "tp" | "ambiguous">[]): ProbabilitySet {
  const touched = list.filter((o) => o.entryTouched);
  const tp = (k: 0 | 1 | 2) => {
    const resolved = touched.filter((o) => o.tp[k] !== null);
    return wilson(resolved.filter((o) => o.tp[k] === true).length, resolved.length);
  };
  return { setups: list.length, entry: wilson(touched.length, list.length), tp1: tp(0), tp2: tp(1), tp3: tp(2), ambiguous: list.filter((o) => o.ambiguous).length };
}

/**
 * Simulasikan setup yang dibuat pada langkah t ∈ [fromSec, toSec) (default: semua).
 * Setiap langkah = penutupan bar TF konteks. Candle sebelum `fromSec` dipakai
 * sebagai pemanasan; candle sesudah `toSec` hanya untuk simulasi hasil.
 */
export function runBacktestTrades(
  candles: Partial<Record<Timeframe, Candle[]>>,
  cfg: EngineConfig,
  o: BacktestOptions = DEFAULT_BT,
  range: { fromSec?: number; toSec?: number } = {},
): BacktestTrade[] {
  const outcomes: SimOutcome[] = [];
  const tfs: Timeframe[] = analysisTfs(cfg);
  for (const pair of cfg.pairs) {
    const ctx = candles[pair.context] ?? [];
    const conf = candles[pair.confirm] ?? [];
    if (ctx.length < 100 || conf.length < 100) continue;
    const pairCfg: EngineConfig = { ...cfg, pairs: [pair] };
    const recent: SetupCandidate[] = [];
    for (let i = 60; i < ctx.length; i++) {
      const t = ctx[i].time + TF_SECONDS[pair.context];
      if ((range.fromSec != null && t < range.fromSec) || (range.toSec != null && t >= range.toSec)) continue;
      const view: Partial<Record<Timeframe, Candle[]>> = {};
      for (const tf of new Set([...tfs, pair.context, pair.confirm])) view[tf] = sliceClosed(candles[tf] ?? [], tf, t, o.window);
      const confView = view[pair.confirm]!;
      if (confView.length < 3) continue;
      const analysis = analyzeMarket({ nowSec: t, candles: view }, tfs, cfg.biasTfs);
      const price = confView[confView.length - 1].close;
      const dctx = { analysis, candles: view, price, spreadPips: o.spreadPips, nowSec: t, dataTime: t, config: pairCfg };
      const cands = dedupeBatch(detectAll(dctx), pairCfg).filter((c) => c.eligible);
      for (const c of cands) {
        const dup = recent.some(
          (r) =>
            r.identityKey === c.identityKey ||
            (r.strategy === c.strategy && r.direction === c.direction && t < r.expiresAt && Math.abs(r.entry - c.entry) < pipsToPrice(cfg.dedupePips, cfg.spec)),
        );
        if (dup) continue;
        recent.push(c);
        outcomes.push({ ...simulate(c, conf.filter((b) => b.time >= t), cfg.spec, o), features: setupFeatures(c, dctx) });
      }
    }
  }
  return outcomes.sort((a, b) => a.setup.createdAt - b.setup.createdAt).map(toTrade);
}

/** Laporan probabilitas ("all" dan "<strategi>|<TF>") dari daftar trade, dengan pemisahan dev/test kronologis. */
export function probabilityReports(trades: BacktestTrade[], o: BacktestOptions = DEFAULT_BT): BacktestReport[] {
  if (trades.length === 0) return [];
  const sorted = [...trades].sort((a, b) => a.createdAt - b.createdAt);
  const from = sorted[0].createdAt;
  const to = sorted[sorted.length - 1].createdAt;
  const splitAt = sorted[Math.min(Math.floor(sorted.length * o.devRatio), sorted.length - 1)].createdAt;
  const groups = new Map<string, BacktestTrade[]>([["all", sorted]]);
  for (const t of sorted) {
    const k = `${t.strategy}|${t.timeframe}`;
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  return [...groups.entries()].map(([key, list]) => {
    const test = probabilities(list.filter((x) => x.createdAt >= splitAt));
    return {
      key,
      periodFrom: from,
      periodTo: to,
      splitAt,
      dev: probabilities(list.filter((x) => x.createdAt < splitAt)),
      test,
      sufficient: test.entry.n >= o.minSamples && test.tp1.n >= o.minSamples,
      options: o,
    };
  });
}

/** Kompatibel dengan versi lama: jalankan + laporkan sekaligus. */
export function runBacktest(candles: Partial<Record<Timeframe, Candle[]>>, cfg: EngineConfig, o: BacktestOptions = DEFAULT_BT): BacktestReport[] {
  return probabilityReports(runBacktestTrades(candles, cfg, o), o);
}

// ---------------------------------------------------------------------------
// Ringkasan manajemen posisi
// ---------------------------------------------------------------------------
export interface VariantStats {
  /** trade dengan entry tersentuh & hasil tuntas */
  n: number;
  winRate: Proportion;
  expPips: number | null;
  /** interval ±1,96·SE untuk ekspektasi pips */
  expLo: number | null;
  expHi: number | null;
  expR: number | null;
  totalPips: number;
  profitFactor: number | null;
  maxDrawdownPips: number;
}

export interface BtGroupStats {
  key: string;
  setups: number;
  probabilities: ProbabilitySet;
  variants: Record<MgmtVariant, VariantStats>;
}

export interface StrategyReport {
  periodFrom: number;
  periodTo: number;
  splitAt: number;
  weeks: number;
  options: BacktestOptions;
  minSamples: number;
  /** data uji (out-of-sample) — headline */
  test: BtGroupStats[];
  /** data pengembangan */
  dev: BtGroupStats[];
}

export function variantStats(trades: BacktestTrade[], v: MgmtVariant): VariantStats {
  const done = trades.filter((t) => t.entryTouched && typeof t.pips?.[v] === "number").sort((a, b) => a.createdAt - b.createdAt);
  const xs = done.map((t) => t.pips![v]);
  const n = xs.length;
  const total = xs.reduce((a, b) => a + b, 0);
  const mean = n ? total / n : null;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - mean!) ** 2, 0) / (n - 1)) : null;
  const se = sd != null ? sd / Math.sqrt(n) : null;
  const gains = xs.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const losses = -xs.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  let peak = 0;
  let equity = 0;
  let dd = 0;
  for (const x of xs) {
    equity += x;
    peak = Math.max(peak, equity);
    dd = Math.max(dd, peak - equity);
  }
  const r = done.map((t) => t.pips![v] / (t.slPips || 1));
  const round = (x: number | null, d = 1) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
  return {
    n,
    winRate: wilson(xs.filter((x) => x > 0).length, n),
    expPips: round(mean),
    expLo: round(mean != null && se != null ? mean - 1.96 * se : null),
    expHi: round(mean != null && se != null ? mean + 1.96 * se : null),
    expR: round(n ? r.reduce((a, b) => a + b, 0) / n : null, 3),
    totalPips: round(total)!,
    profitFactor: losses > 0 ? round(gains / losses, 2) : null, // tanpa rugi → tidak terdefinisi
    maxDrawdownPips: round(dd)!,
  };
}

function groupStats(key: string, list: BacktestTrade[]): BtGroupStats {
  return {
    key,
    setups: list.length,
    probabilities: probabilities(list),
    variants: Object.fromEntries(MGMT_VARIANTS.map((v) => [v, variantStats(list, v)])) as Record<MgmtVariant, VariantStats>,
  };
}

function grouped(trades: BacktestTrade[]): BtGroupStats[] {
  const groups = new Map<string, BacktestTrade[]>([["all", trades]]);
  const add = (k: string, t: BacktestTrade) => groups.set(k, [...(groups.get(k) ?? []), t]);
  for (const t of trades) {
    add(`strategy:${t.strategy}|${t.timeframe}`, t);
    add(`session:${t.session}`, t);
    add(`direction:${t.direction}`, t);
  }
  return [...groups.entries()].map(([k, list]) => groupStats(k, list));
}

/** Ringkasan per grup (all, strategi|TF, sesi, arah) dan per varian manajemen, dev vs test. */
export function summarizeTrades(trades: BacktestTrade[], o: BacktestOptions = DEFAULT_BT): StrategyReport | null {
  if (trades.length === 0) return null;
  const sorted = [...trades].sort((a, b) => a.createdAt - b.createdAt);
  const from = sorted[0].createdAt;
  const to = sorted[sorted.length - 1].createdAt;
  const splitAt = sorted[Math.min(Math.floor(sorted.length * o.devRatio), sorted.length - 1)].createdAt;
  return {
    periodFrom: from,
    periodTo: to,
    splitAt,
    weeks: Math.max(1, Math.round(((to - from) / (7 * 86400)) * 10) / 10),
    options: o,
    minSamples: o.minSamples,
    test: grouped(sorted.filter((t) => t.createdAt >= splitAt)),
    dev: grouped(sorted.filter((t) => t.createdAt < splitAt)),
  };
}

// ---------------------------------------------------------------------------
// Penjadwalan potongan (chunk) backtest panjang
// ---------------------------------------------------------------------------
export const CHUNK_SEC = 7 * 86400;
/** Potongan dimulai Senin 00:00 UTC agar akhir pekan tidak membelah data hari kerja. */
const CHUNK_ANCHOR = Date.UTC(2024, 0, 1) / 1000; // Senin

export function chunkStartOf(tSec: number): number {
  return CHUNK_ANCHOR + Math.floor((tSec - CHUNK_ANCHOR) / CHUNK_SEC) * CHUNK_SEC;
}

/**
 * Potongan berikutnya yang perlu dihitung, dari terbaru ke terlama dalam `months`
 * bulan terakhir. `done` = potongan yang sudah final (selesai dihitung setelah
 * akhirnya + 1 hari masa simulasi). Potongan berjalan dihitung ulang bila
 * hasilnya lebih tua dari `refreshSec`.
 */
export function nextChunk(
  done: { start: number; computedAt: number }[],
  nowSec: number,
  months = 12,
  refreshSec = 6 * 3600,
): number | null {
  const byStart = new Map(done.map((d) => [d.start, d.computedAt]));
  const oldest = chunkStartOf(nowSec - months * 30.44 * 86400);
  for (let s = chunkStartOf(nowSec); s >= oldest; s -= CHUNK_SEC) {
    const at = byStart.get(s);
    const final = at != null && at >= s + CHUNK_SEC + 86400;
    if (at == null) return s;
    if (!final && nowSec - at >= refreshSec) return s;
  }
  return null;
}

/** Jumlah potongan yang dijelajahi nextChunk untuk periode ini — versi dianggap lengkap bila semuanya ada. */
export function expectedChunks(nowSec: number, months = 12): number {
  const oldest = chunkStartOf(nowSec - months * 30.44 * 86400);
  return Math.floor((chunkStartOf(nowSec) - oldest) / CHUNK_SEC) + 1;
}

// ---------------------------------------------------------------------------
// Pemilihan varian yang jujur: dipilih dari data PENGEMBANGAN, dibuktikan di data UJI
// ---------------------------------------------------------------------------
export interface VariantPick {
  variant: MgmtVariant;
  /** memenuhi target win rate & ekspektasi positif di data pengembangan */
  meetsTarget: boolean;
  dev: VariantStats;
  test: VariantStats | null;
  /** hasil di data uji: terbukti (WR ≥ target & interval ekspektasi > 0), positif (belum signifikan), atau gagal */
  verdict: "terbukti" | "positif" | "gagal" | "sampel_kurang";
}

/**
 * Pilih varian dengan ekspektasi tertinggi di antara varian yang di data
 * pengembangan punya win rate ≥ `targetWr`, ekspektasi > 0, dan n cukup.
 * Bila tidak ada, pilih ekspektasi tertinggi (meetsTarget = false). Data uji
 * TIDAK dipakai untuk memilih — hanya untuk membuktikan.
 */
export function pickVariant(report: StrategyReport, targetWr = 0.75): VariantPick | null {
  const dev = report.dev.find((g) => g.key === "all");
  const test = report.test.find((g) => g.key === "all");
  if (!dev) return null;
  const ok = (st: VariantStats) => st.n >= report.minSamples && (st.expPips ?? -Infinity) > 0;
  const byExp = (a: MgmtVariant, b: MgmtVariant) => (dev.variants[b].expPips ?? -Infinity) - (dev.variants[a].expPips ?? -Infinity);
  const eligible = MGMT_VARIANTS.filter((v) => dev.variants[v] && ok(dev.variants[v]) && (dev.variants[v].winRate.p ?? 0) >= targetWr).sort(byExp);
  const variant = eligible[0] ?? MGMT_VARIANTS.filter((v) => dev.variants[v]).sort(byExp)[0];
  const t = test?.variants[variant] ?? null;
  const verdict: VariantPick["verdict"] =
    !t || t.n < report.minSamples ? "sampel_kurang" : (t.expLo ?? -1) > 0 && (t.winRate.p ?? 0) >= targetWr ? "terbukti" : (t.expPips ?? 0) > 0 ? "positif" : "gagal";
  return { variant, meetsTarget: eligible.length > 0, dev: dev.variants[variant], test: t, verdict };
}
