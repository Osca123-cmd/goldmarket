import type { Candle, Direction, EntryType, MarketBias, StrategyId, Timeframe } from "./types.ts";
import { TF_SECONDS } from "./types.ts";
import { planFor, type EngineConfig, type TfPair } from "./config.ts";
import type { MultiTfAnalysis, TfAnalysis } from "./analysis.ts";
import { buildLevels, isBearishConfirmation, isBullishConfirmation, type Level } from "./structure.ts";
import { levelsFromEntry, pipsToPrice, priceToPips, roundToTick, type TradeLevels } from "./instrument.ts";
import { scoreSetup, type ScoreBreakdown } from "./scoring.ts";
import { asiaRange, prevDayRange } from "./features.ts";

export interface Gate {
  key: "data" | "structure" | "invalidation" | "volatility" | "risk";
  label: string;
  pass: boolean;
  note: string;
}

export interface SetupCandidate extends TradeLevels {
  identityKey: string;
  strategy: StrategyId;
  direction: Direction;
  timeframe: Timeframe;
  confirmTf: Timeframe;
  entryType: EntryType;
  entryLow: number;
  entryHigh: number;
  invalidation: number;
  slPips: number;
  spreadPips: number;
  rr: { tp1: number; tp2: number; tp3: number; tp2AfterCost: number };
  score: ScoreBreakdown;
  gates: Gate[];
  eligible: boolean;
  confirmed: boolean;
  confirmation: string | null;
  reasons: string[];
  createdAt: number;
  expiresAt: number;
  dataTime: number;
}

export interface DetectContext {
  analysis: MultiTfAnalysis;
  candles: Partial<Record<Timeframe, Candle[]>>; // tertutup saja
  price: number; // harga intrabar terkini (boleh untuk jarak entry)
  spreadPips: number;
  nowSec: number;
  dataTime: number;
  config: EngineConfig;
}

const sgn = (d: Direction) => (d === "BUY" ? 1 : -1);
const dirBias = (d: Direction): MarketBias => (d === "BUY" ? "bullish" : "bearish");
const opposite = (b: MarketBias, d: Direction) => b === (d === "BUY" ? "bearish" : "bullish");

function confirmationOf(d: Direction, candles: Candle[]): { text: string; candle: Candle } | null {
  if (candles.length < 2) return null;
  const c = candles[candles.length - 1];
  const p = candles[candles.length - 2];
  const t = d === "BUY" ? isBullishConfirmation(p, c) : isBearishConfirmation(p, c);
  return t ? { text: t, candle: c } : null;
}

interface Draft {
  strategy: StrategyId;
  direction: Direction;
  pair: TfPair;
  ctx: TfAnalysis;
  conf: TfAnalysis | undefined;
  zoneLow: number;
  zoneHigh: number;
  invalidation: number | null;
  levelTouches: number;
  anchor: string;
  confirmCandles: Candle[];
  /** candle konfirmasi harus tertutup setelah waktu ini (detik) */
  confirmAfter: number;
  reasons: string[];
}

/**
 * Gate "SL vs invalidasi": invalidasi harus di antara entry dan SL. `insideBy` = seberapa jauh (harga)
 * SL berada di dalam invalidasi (0 bila SL sudah di luarnya); lolos bila insideBy ≤ toleransi.
 */
export function invalidationGate(direction: Direction, entry: number, sl: number, invalidation: number, tolPrice: number) {
  const s = direction === "BUY" ? 1 : -1;
  const between = s * (entry - invalidation) > 0;
  const insideBy = Math.max(0, s * (sl - invalidation));
  return { between, insideBy, ok: between && insideBy <= tolPrice + 1e-9 };
}

function finalize(d: Draft, c: DetectContext): SetupCandidate {
  const { spec } = c.config;
  const plan = planFor(c.config, d.pair.context);
  const s = sgn(d.direction);
  const atrCtx = d.ctx.atr;
  const atrConf = d.conf?.atr ?? atrCtx / 2;
  const reasons = [...d.reasons];

  const conf = confirmationOf(d.direction, d.confirmCandles);
  const lastConf = conf && conf.candle.time >= d.confirmAfter ? conf : null;
  const touchesZone =
    lastConf &&
    (d.direction === "BUY"
      ? lastConf.candle.low <= d.zoneHigh + 0.1 * atrCtx && lastConf.candle.close >= d.zoneLow
      : lastConf.candle.high >= d.zoneLow - 0.1 * atrCtx && lastConf.candle.close <= d.zoneHigh);
  const confirmed = Boolean(lastConf && touchesZone);
  const priceInZone = c.price >= d.zoneLow - 0.2 * atrCtx && c.price <= d.zoneHigh + 0.2 * atrCtx;
  const priceStrictInZone = c.price >= d.zoneLow && c.price <= d.zoneHigh;

  let entryType: EntryType;
  let entry: number;
  if (confirmed && priceInZone) {
    entryType = "market";
    entry = c.price;
    reasons.push(`Konfirmasi ${d.pair.confirm}: ${lastConf!.text}; harga masih di area → entry market.`);
  } else if (s * (c.price - (d.direction === "BUY" ? d.zoneHigh : d.zoneLow)) > 0) {
    entryType = "limit";
    entry = d.direction === "BUY" ? d.zoneHigh : d.zoneLow;
    reasons.push("Harga belum masuk area → limit di tepi area; tunggu konfirmasi candle tertutup.");
  } else if (priceStrictInZone) {
    const last = d.confirmCandles[d.confirmCandles.length - 1];
    entryType = "stop";
    entry = d.direction === "BUY" ? last.high + 0.05 * atrConf : last.low - 0.05 * atrConf;
    reasons.push(`Harga di dalam area tanpa konfirmasi → stop di ${d.direction === "BUY" ? "atas high" : "bawah low"} candle ${d.pair.confirm} terakhir sebagai pemicu.`);
  } else {
    entryType = "stop";
    entry = d.direction === "BUY" ? d.zoneLow : d.zoneHigh;
    reasons.push("Harga di sisi berlawanan area → stop saat harga kembali ke area.");
  }
  entry = roundToTick(entry, spec);
  const lv = levelsFromEntry(d.direction, entry, plan, spec);
  const slPrice = Math.abs(lv.entry - lv.sl);
  const spread = c.spreadPips;
  const rr = {
    tp1: plan.tp1Pips / plan.slPips,
    tp2: plan.tp2Pips / plan.slPips,
    tp3: plan.tp3Pips / plan.slPips,
    tp2AfterCost: (plan.tp2Pips - spread) / (plan.slPips + spread),
  };

  const gates: Gate[] = [];
  gates.push({ key: "data", label: "Kualitas data", pass: true, note: "Lolos validasi data sebelum deteksi." });
  // sd_reversal sengaja dua arah, tetapi hanya saat H4 ranging (dicek di detektornya)
  const counterOk = d.strategy === "sd_reversal" && c.analysis.tfs.H4?.bias === "ranging";
  const biasOpposite = opposite(c.analysis.mainBias, d.direction) && !counterOk;
  const structOk = d.invalidation != null && !biasOpposite;
  gates.push({
    key: "structure",
    label: "Struktur",
    pass: structOk,
    note:
      d.invalidation == null
        ? "Tidak ada level invalidasi struktur yang jelas."
        : biasOpposite
          ? "Bias utama berlawanan."
          : counterOk
            ? "Invalidasi struktur terdefinisi; H4 ranging sehingga reversal dua arah diizinkan."
            : "Invalidasi struktur terdefinisi dan bias tidak berlawanan.",
  });
  let invOk = false;
  let invNote = "Tidak ada invalidasi.";
  if (d.invalidation != null) {
    const inv = d.invalidation;
    const tolPips = c.config.invalidationTolPips;
    const g = invalidationGate(d.direction, lv.entry, lv.sl, inv, pipsToPrice(tolPips, spec));
    const insidePips = priceToPips(g.insideBy, spec);
    invOk = g.ok;
    invNote = !g.between
      ? `Entry ${lv.entry.toFixed(2)} sudah melewati invalidasi ${inv.toFixed(2)}.`
      : !g.ok
        ? `SL tetap ${plan.slPips} pips (${lv.sl.toFixed(2)}) lebih sempit dari invalidasi struktur ${inv.toFixed(2)}${tolPips > 0 ? ` (${insidePips.toFixed(1)} pips di dalam, toleransi ${tolPips} pips)` : ""} — SL bisa kena sebelum ide setup batal. Setup tidak layak; level tidak diubah.`
        : g.insideBy > 0
          ? `SL ${lv.sl.toFixed(2)} hanya ${insidePips.toFixed(1)} pips di dalam invalidasi ${inv.toFixed(2)} — masih dalam toleransi ${tolPips} pips.`
          : `Invalidasi ${inv.toFixed(2)} berada di antara entry dan SL ${lv.sl.toFixed(2)}.`;
  }
  gates.push({ key: "invalidation", label: "SL vs invalidasi", pass: invOk, note: invNote });
  const volOk = slPrice >= c.config.minSlAtrConfirm * atrConf && slPrice >= c.config.minSlAtrContext * atrCtx;
  gates.push({
    key: "volatility",
    label: "Volatilitas",
    pass: volOk,
    note: `SL ${slPrice.toFixed(2)} = ${(slPrice / atrConf).toFixed(2)}× ATR ${d.pair.confirm} dan ${(slPrice / atrCtx).toFixed(2)}× ATR ${d.pair.context}${volOk ? "" : " — terlalu sempit untuk volatilitas saat ini"}.`,
  });
  const riskOk = rr.tp2AfterCost >= c.config.minRrAfterCost && spread <= c.config.thresholds.maxSpreadPips;
  gates.push({
    key: "risk",
    label: "Kelayakan risiko",
    pass: riskOk,
    note: `RR TP2 setelah spread ${spread} pips = ${rr.tp2AfterCost.toFixed(2)} (min ${c.config.minRrAfterCost}).`,
  });

  const opposing = c.analysis.tfs[d.pair.context]?.levels.filter((l) =>
    d.direction === "BUY" ? l.price > lv.entry && l.price < lv.tp1 : l.price < lv.entry && l.price > lv.tp1,
  );
  const score = scoreSetup({
    direction: d.direction,
    mainBias: c.analysis.mainBias,
    strongBias: c.analysis.strongBias,
    levelTouches: d.levelTouches,
    hasStructuralInvalidation: d.invalidation != null,
    roomToTp1: !opposing || opposing.length === 0,
    confirmed,
    rsi: d.ctx.rsi,
    rsiPrev: d.ctx.rsiPrev,
    slAtrContext: slPrice / atrCtx,
    spreadPips: spread,
    slPips: plan.slPips,
  });

  const expiresAt = c.nowSec + c.config.expiryBars[d.strategy] * TF_SECONDS[d.pair.context];
  return {
    ...lv,
    identityKey: `${d.strategy}|${d.direction}|${d.pair.context}|${d.anchor}`,
    strategy: d.strategy,
    direction: d.direction,
    timeframe: d.pair.context,
    confirmTf: d.pair.confirm,
    entryType,
    entryLow: roundToTick(d.zoneLow, spec),
    entryHigh: roundToTick(d.zoneHigh, spec),
    invalidation: d.invalidation != null ? roundToTick(d.invalidation, spec) : NaN,
    slPips: plan.slPips,
    spreadPips: spread,
    rr,
    score,
    gates,
    eligible: gates.every((g) => g.pass),
    confirmed,
    confirmation: confirmed ? lastConf!.text : null,
    reasons,
    createdAt: c.nowSec,
    expiresAt,
    dataTime: c.dataTime,
  };
}

/** Trend pullback: retracement ke area EMA20–EMA50 (± support/resistance) searah bias utama. */
export function detectTrendPullback(direction: Direction, pair: TfPair, c: DetectContext): SetupCandidate | null {
  const ctx = c.analysis.tfs[pair.context];
  const confCandles = c.candles[pair.confirm] ?? [];
  if (!ctx || confCandles.length < 3) return null;
  if (c.analysis.mainBias !== dirBias(direction)) return null;
  if (opposite(ctx.bias, direction)) return null;
  const s = sgn(direction);
  if (s * (ctx.ema20 - ctx.ema50) <= 0) return null;
  const a = ctx.atr;
  let lo = Math.min(ctx.ema20, ctx.ema50);
  let hi = Math.max(ctx.ema20, ctx.ema50);
  if (hi - lo < 0.3 * a) {
    const mid = (hi + lo) / 2;
    lo = mid - 0.15 * a;
    hi = mid + 0.15 * a;
  }
  const impulse = direction === "BUY" ? ctx.structure.lastHigh : ctx.structure.lastLow;
  if (!impulse) return null;
  // harus sudah ada retracement dari ujung impuls
  if (s * (impulse.price - c.price) < 0.3 * a) return null;
  // harga tidak terlalu jauh dari area
  const edge = direction === "BUY" ? hi : lo;
  if (s * (c.price - edge) > c.config.maxDistanceAtr * a) return null;

  const levelKind: Level["kind"] = direction === "BUY" ? "support" : "resistance";
  const lvl = ctx.levels.find((l) => l.kind === levelKind && l.price >= lo - 0.5 * a && l.price <= hi + 0.5 * a);
  if (lvl) {
    lo = Math.min(lo, lvl.price);
    hi = Math.max(hi, lvl.price);
  }

  const swingsOpp = ctx.swings.filter((sw) => sw.kind === (direction === "BUY" ? "low" : "high")).reverse();
  const invSwing = swingsOpp.find((sw) => (direction === "BUY" ? sw.price < lo && sw.price > lo - 3 * a : sw.price > hi && sw.price < hi + 3 * a));
  const invalidation = invSwing ? invSwing.price - s * 0.1 * a : null;
  if (invalidation != null && s * (c.price - invalidation) <= 0) return null;

  const reasons = [
    ...c.analysis.reasons,
    `${pair.context}: EMA20 ${direction === "BUY" ? "di atas" : "di bawah"} EMA50; harga retracement dari ${direction === "BUY" ? "swing high" : "swing low"} ${impulse.price.toFixed(2)}.`,
    `Area pullback ${lo.toFixed(2)}–${hi.toFixed(2)} (EMA20/EMA50${lvl ? ` + ${levelKind} ${lvl.price.toFixed(2)} (${lvl.touches}×)` : ""}).`,
    invSwing ? `Invalidasi di luar swing ${invSwing.price.toFixed(2)}.` : "Tidak ditemukan swing untuk invalidasi.",
  ];
  return finalize(
    {
      strategy: "trend_pullback",
      direction,
      pair,
      ctx,
      conf: c.analysis.tfs[pair.confirm],
      zoneLow: lo,
      zoneHigh: hi,
      invalidation,
      levelTouches: lvl?.touches ?? 1,
      anchor: String(impulse.time),
      confirmCandles: confCandles,
      confirmAfter: impulse.time,
      reasons,
    },
    c,
  );
}

/** Breakout retest: close kuat menembus level ≥2 sentuhan, lalu harga menguji ulang level tersebut. */
export function detectBreakoutRetest(direction: Direction, pair: TfPair, c: DetectContext): SetupCandidate | null {
  const ctx = c.analysis.tfs[pair.context];
  const cs = c.candles[pair.context] ?? [];
  const confCandles = c.candles[pair.confirm] ?? [];
  if (!ctx || cs.length < 60 || confCandles.length < 3) return null;
  if (opposite(c.analysis.mainBias, direction)) return null;
  const s = sgn(direction);
  const a = ctx.atr;
  const n = cs.length - 1;
  for (let k = n; k >= Math.max(1, n - 20); k--) {
    const bar = cs[k];
    const prev = cs[k - 1];
    const body = Math.abs(bar.close - bar.open);
    if (body < 0.5 * a || s * (bar.close - bar.open) <= 0) continue;
    const before = ctx.swings.filter((sw) => sw.index <= k - 4);
    const levels = buildLevels(before, prev.close, 0.25 * a).filter((l) => l.touches >= 2);
    const L = levels.find((l) =>
      direction === "BUY"
        ? l.kind === "resistance" && prev.close <= l.price && bar.close > l.price + 0.1 * a
        : l.kind === "support" && prev.close >= l.price && bar.close < l.price - 0.1 * a,
    );
    if (!L) continue;
    // breakout gagal bila ada close kembali jauh ke dalam range
    const after = cs.slice(k + 1);
    if (after.some((b) => s * (b.close - (L.price - s * 0.25 * a)) < 0)) return null;
    const zoneLow = direction === "BUY" ? L.price - 0.15 * a : L.price - 0.25 * a;
    const zoneHigh = direction === "BUY" ? L.price + 0.25 * a : L.price + 0.15 * a;
    const edge = direction === "BUY" ? zoneHigh : zoneLow;
    if (s * (c.price - edge) > c.config.maxDistanceAtr * a) return null;
    const invalidation = L.price - s * 0.6 * a;
    if (s * (c.price - invalidation) <= 0) return null;
    const reasons = [
      ...c.analysis.reasons,
      `${pair.context}: close ${bar.close.toFixed(2)} menembus ${L.kind === "resistance" ? "resistance" : "support"} ${L.price.toFixed(2)} (${L.touches}× sentuhan) dengan body ${(body / a).toFixed(2)}× ATR.`,
      `Area retest ${zoneLow.toFixed(2)}–${zoneHigh.toFixed(2)}; invalidasi bila harga kembali ke ${invalidation.toFixed(2)}.`,
    ];
    return finalize(
      {
        strategy: "breakout_retest",
        direction,
        pair,
        ctx,
        conf: c.analysis.tfs[pair.confirm],
        zoneLow,
        zoneHigh,
        invalidation,
        levelTouches: L.touches,
        anchor: `${L.price.toFixed(2)}@${bar.time}`,
        confirmCandles: confCandles,
        confirmAfter: bar.time + TF_SECONDS[pair.context],
        reasons,
      },
      c,
    );
  }
  return null;
}

/**
 * Liquidity sweep: candle konteks menembus high/low hari sebelumnya, range Asia,
 * atau swing terakhir (mengambil stop), lalu MENUTUP kembali di dalam level.
 * Setup = retest level yang direbut kembali, searah pembalikan. Invalidasi di
 * luar ujung sweep. (Riset: aktif di backtest; sinyal live hanya bila terbukti.)
 */
export function detectLiquiditySweep(direction: Direction, pair: TfPair, c: DetectContext): SetupCandidate | null {
  const ctx = c.analysis.tfs[pair.context];
  const cs = c.candles[pair.context] ?? [];
  const confCandles = c.candles[pair.confirm] ?? [];
  if (!ctx || cs.length < 60 || confCandles.length < 3) return null;
  const s = sgn(direction);
  const a = ctx.atr;
  const n = cs.length - 1;
  const pd = prevDayRange(c.candles.H1 ?? [], c.nowSec);
  const asia = asiaRange(c.candles.M15 ?? [], c.nowSec);
  const swingsOpp = ctx.swings.filter((sw) => sw.kind === (direction === "BUY" ? "low" : "high") && sw.index <= n - 3).slice(-3);
  const refs: { price: number; name: string }[] = [];
  if (pd) refs.push({ price: direction === "BUY" ? pd.low : pd.high, name: direction === "BUY" ? "low hari sebelumnya" : "high hari sebelumnya" });
  if (asia) refs.push({ price: direction === "BUY" ? asia.low : asia.high, name: direction === "BUY" ? "low sesi Asia" : "high sesi Asia" });
  for (const sw of swingsOpp) refs.push({ price: sw.price, name: `swing ${direction === "BUY" ? "low" : "high"}` });
  for (let k = n; k >= Math.max(1, n - 2); k--) {
    const bar = cs[k];
    if (bar.high - bar.low > 3 * a) continue; // candle berita/ekstrem
    const wick = direction === "BUY" ? bar.low : bar.high;
    const L = refs.find((r) => s * (r.price - wick) > 0.1 * a && s * (bar.close - r.price) > 0);
    if (!L) continue;
    // harga sesudahnya tidak boleh kembali menutup di luar level (sweep gagal)
    if (cs.slice(k + 1).some((b) => s * (b.close - L.price) < 0)) return null;
    const zoneLow = direction === "BUY" ? L.price - 0.1 * a : L.price - 0.3 * a;
    const zoneHigh = direction === "BUY" ? L.price + 0.3 * a : L.price + 0.1 * a;
    const edge = direction === "BUY" ? zoneHigh : zoneLow;
    if (s * (c.price - edge) > c.config.maxDistanceAtr * a) return null;
    const invalidation = wick - s * 0.1 * a;
    if (s * (c.price - invalidation) <= 0) return null;
    const reasons = [
      ...c.analysis.reasons,
      `${pair.context}: candle ${new Date(bar.time * 1000).toISOString().slice(11, 16)} UTC menembus ${L.name} ${L.price.toFixed(2)} (ujung ${wick.toFixed(2)}) lalu menutup kembali ${direction === "BUY" ? "di atasnya" : "di bawahnya"} → likuiditas diambil.`,
      `Area retest ${zoneLow.toFixed(2)}–${zoneHigh.toFixed(2)}; invalidasi di luar ujung sweep ${invalidation.toFixed(2)}.`,
    ];
    return finalize(
      {
        strategy: "liquidity_sweep",
        direction,
        pair,
        ctx,
        conf: c.analysis.tfs[pair.confirm],
        zoneLow,
        zoneHigh,
        invalidation,
        levelTouches: 2,
        anchor: `sweep:${L.price.toFixed(2)}@${bar.time}`,
        confirmCandles: confCandles,
        confirmAfter: bar.time + TF_SECONDS[pair.context],
        reasons,
      },
      c,
    );
  }
  return null;
}

/**
 * Supply/Demand reversal: saat H4 ranging, harga mendekati level ≥2 sentuhan dari
 * arah berlawanan (resistance di atas = supply → SELL, support di bawah = demand → BUY)
 * dan diharapkan memantul; konfirmasi candle pembalikan di TF konfirmasi menambah skor.
 * Invalidasi 0,35× ATR di luar level: bila zona ditembus sejauh itu, ide pantulan batal
 * (lebih rapat dari breakout retest agar SL tetap rencana TF bisa melindunginya). Dua arah,
 * boleh melawan bias H1. (Eksperimen.)
 */
export function detectSdReversal(direction: Direction, pair: TfPair, c: DetectContext): SetupCandidate | null {
  const ctx = c.analysis.tfs[pair.context];
  const confCandles = c.candles[pair.confirm] ?? [];
  if (!ctx || confCandles.length < 3) return null;
  if (c.analysis.tfs.H4?.bias !== "ranging") return null;
  const s = sgn(direction);
  const a = ctx.atr;
  // BUY: support di bawah/di sekitar harga; SELL: resistance di atas/di sekitar harga
  const L = ctx.levels
    .filter((l) => l.touches >= 2 && l.kind === (direction === "BUY" ? "support" : "resistance") && s * (c.price - l.price) >= -0.25 * a)
    .sort((x, y) => Math.abs(x.price - c.price) - Math.abs(y.price - c.price))[0];
  if (!L) return null;
  const zoneLow = direction === "BUY" ? L.price - 0.1 * a : L.price - 0.25 * a;
  const zoneHigh = direction === "BUY" ? L.price + 0.25 * a : L.price + 0.1 * a;
  const edge = direction === "BUY" ? zoneHigh : zoneLow;
  if (s * (c.price - edge) > c.config.maxDistanceAtr * a) return null;
  const invalidation = L.price - s * 0.35 * a;
  if (s * (c.price - invalidation) <= 0) return null;
  const reasons = [
    ...c.analysis.reasons,
    `H4 ranging: reversal dua arah di zona ${direction === "BUY" ? "demand (support)" : "supply (resistance)"} ${L.price.toFixed(2)} (${L.touches}× sentuhan) ${pair.context}.`,
    `Area entry ${zoneLow.toFixed(2)}–${zoneHigh.toFixed(2)}; invalidasi bila harga menembus ${invalidation.toFixed(2)}.`,
  ];
  return finalize(
    {
      strategy: "sd_reversal",
      direction,
      pair,
      ctx,
      conf: c.analysis.tfs[pair.confirm],
      zoneLow,
      zoneHigh,
      invalidation,
      levelTouches: L.touches,
      anchor: `sd:${L.price.toFixed(2)}`,
      confirmCandles: confCandles,
      confirmAfter: 0,
      reasons,
    },
    c,
  );
}

export function detectAll(c: DetectContext): SetupCandidate[] {
  const out: SetupCandidate[] = [];
  for (const pair of c.config.pairs) {
    for (const dir of ["BUY", "SELL"] as Direction[]) {
      if (c.config.strategies.includes("trend_pullback")) {
        const p = detectTrendPullback(dir, pair, c);
        if (p) out.push(p);
      }
      if (c.config.strategies.includes("breakout_retest")) {
        const b = detectBreakoutRetest(dir, pair, c);
        if (b) out.push(b);
      }
      if (c.config.strategies.includes("liquidity_sweep")) {
        const l = detectLiquiditySweep(dir, pair, c);
        if (l) out.push(l);
      }
      if (c.config.strategies.includes("sd_reversal")) {
        const r = detectSdReversal(dir, pair, c);
        if (r) out.push(r);
      }
    }
  }
  return out.filter((x) => x.score.total >= c.config.engineMinScore);
}
