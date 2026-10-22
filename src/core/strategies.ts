import type { Candle, Direction, EntryType, MarketBias, StopKind, StrategyId, Timeframe } from "./types.ts";
import { TF_SECONDS } from "./types.ts";
import { TWO_WAY_STRATEGIES, planFor, type EngineConfig, type TfPair } from "./config.ts";
import type { MultiTfAnalysis, TfAnalysis } from "./analysis.ts";
import { buildLevels, isBearishConfirmation, isBullishConfirmation, type Level, type Swing } from "./structure.ts";
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
  /** hanya untuk entry stop: kasus mana yang memicu */
  stopKind?: StopKind;
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

/** jarak invalidasi (× ATR konteks) per strategi dari config, atau nilai asli detektor */
const invAtr = (c: DetectContext, id: StrategyId, fallback: number) => c.config.invalidationAtr?.[id] ?? fallback;
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
  let stopKind: StopKind | undefined;
  let entry: number;
  if (confirmed && priceInZone) {
    entryType = "market";
    entry = c.price;
    reasons.push(`Konfirmasi ${d.pair.confirm}: ${lastConf!.text}; harga masih di area → entry market.`);
  } else if (s * (c.price - (d.direction === "BUY" ? d.zoneHigh : d.zoneLow)) > 0) {
    entryType = "limit";
    const near = d.direction === "BUY" ? d.zoneHigh : d.zoneLow;
    const far = d.direction === "BUY" ? d.zoneLow : d.zoneHigh;
    const depth = Math.min(1, Math.max(0, c.config.limitDepth?.[d.strategy] ?? 0));
    entry = near + depth * (far - near);
    reasons.push(
      depth === 0
        ? "Harga belum masuk area → limit di tepi area; tunggu konfirmasi candle tertutup."
        : `Harga belum masuk area → limit ${depth >= 1 ? "di tepi jauh" : "di tengah"} area (entry lebih dalam, SL lebih jauh dari zona); tunggu konfirmasi candle tertutup.`,
    );
  } else if (priceStrictInZone) {
    const last = d.confirmCandles[d.confirmCandles.length - 1];
    entryType = "stop";
    stopKind = "in_zone";
    entry = d.direction === "BUY" ? last.high + 0.05 * atrConf : last.low - 0.05 * atrConf;
    reasons.push(`Harga di dalam area tanpa konfirmasi → stop di ${d.direction === "BUY" ? "atas high" : "bawah low"} candle ${d.pair.confirm} terakhir sebagai pemicu.`);
  } else {
    entryType = "stop";
    stopKind = "back_to_zone";
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
  // sd_reversal sengaja dua arah, tetapi hanya saat TF bias besar ranging (dicek di detektornya);
  // msnr_flip & fvg_retest dua arah penuh (permintaan pengguna 20 Okt 2026): level/celah segar sudah menandai arah dorongan
  const counterOk = (d.strategy === "sd_reversal" && c.analysis.tfs[c.config.biasTfs.major]?.bias === "ranging") || TWO_WAY_STRATEGIES.includes(d.strategy);
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
          : counterOk && opposite(c.analysis.mainBias, d.direction)
            ? `Invalidasi struktur terdefinisi; strategi dua arah, melawan bias utama diizinkan.`
            : counterOk && d.strategy === "sd_reversal"
            ? `Invalidasi struktur terdefinisi; ${c.config.biasTfs.major} ranging sehingga reversal dua arah diizinkan.`
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
  // TF konfirmasi = TF konteks (mis. M15/M15): cukup batas ATR konteks
  const sameTf = d.pair.confirm === d.pair.context;
  const volOk = (sameTf || slPrice >= c.config.minSlAtrConfirm * atrConf) && slPrice >= c.config.minSlAtrContext * atrCtx;
  gates.push({
    key: "volatility",
    label: "Volatilitas",
    pass: volOk,
    note: `SL ${slPrice.toFixed(2)} = ${sameTf ? "" : `${(slPrice / atrConf).toFixed(2)}× ATR ${d.pair.confirm} dan `}${(slPrice / atrCtx).toFixed(2)}× ATR ${d.pair.context}${volOk ? "" : " — terlalu sempit untuk volatilitas saat ini"}.`,
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
    infoBias: c.config.infoTf ? c.analysis.tfs[c.config.infoTf]?.bias : undefined,
    infoTf: c.config.infoTf,
    majorTf: c.config.biasTfs.major,
    minorTf: c.config.biasTfs.minor,
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
    stopKind,
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
  const zoneInv = c.config.invalidationAtr?.trend_pullback;
  const invalidation = zoneInv != null ? (direction === "BUY" ? lo : hi) - s * zoneInv * a : invSwing ? invSwing.price - s * 0.1 * a : null;
  if (invalidation != null && s * (c.price - invalidation) <= 0) return null;

  const reasons = [
    ...c.analysis.reasons,
    `${pair.context}: EMA20 ${direction === "BUY" ? "di atas" : "di bawah"} EMA50; harga retracement dari ${direction === "BUY" ? "swing high" : "swing low"} ${impulse.price.toFixed(2)}.`,
    `Area pullback ${lo.toFixed(2)}–${hi.toFixed(2)} (EMA20/EMA50${lvl ? ` + ${levelKind} ${lvl.price.toFixed(2)} (${lvl.touches}×)` : ""}).`,
    zoneInv != null
      ? `Invalidasi bila harga menembus area EMA sejauh ${zoneInv} ATR (${invalidation!.toFixed(2)}).`
      : invSwing
        ? `Invalidasi di luar swing ${invSwing.price.toFixed(2)}.`
        : "Tidak ditemukan swing untuk invalidasi.",
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
    const invalidation = L.price - s * invAtr(c, "breakout_retest", 0.6) * a;
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
 * luar ujung sweep. Live sebagai EKSPERIMEN sejak 19 Okt 2026 (SL/TP sama dengan rencana per TF).
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
 * Supply/Demand reversal: saat TF bias besar (H1) ranging, harga mendekati level ≥2 sentuhan dari
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
  const major = c.config.biasTfs.major;
  if (c.analysis.tfs[major]?.bias !== "ranging") return null;
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
  const invalidation = L.price - s * invAtr(c, "sd_reversal", 0.35) * a;
  if (s * (c.price - invalidation) <= 0) return null;
  const reasons = [
    ...c.analysis.reasons,
    `${major} ranging: reversal dua arah di zona ${direction === "BUY" ? "demand (support)" : "supply (resistance)"} ${L.price.toFixed(2)} (${L.touches}× sentuhan) ${pair.context}.`,
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
      anchor: `sd:${L.price.toFixed(2)}@${L.lastTime}`, // sentuhan baru pada level = setup baru
      confirmCandles: confCandles,
      confirmAfter: 0,
      reasons,
    },
    c,
  );
}

/**
 * CRT (Candle Range Theory): candle konteks setelah candle H1 `range` tertutup menembus ujung range
 * (≥ 0,1 ATR konteks) lalu MENUTUP kembali di dalamnya; candle sesudahnya tidak boleh menutup di luar lagi.
 * BUY = sapuan di bawah low, SELL = sapuan di atas high. Mengembalikan candle sapuan atau null.
 */
export function findCrtSweep(direction: Direction, range: Candle, bars: Candle[], atr: number, rangeSec = 3600): Candle | null {
  const s = sgn(direction);
  const edge = direction === "BUY" ? range.low : range.high;
  const after = bars.filter((b) => b.time >= range.time + rangeSec).slice(-3);
  for (let k = after.length - 1; k >= 0; k--) {
    const b = after[k];
    const wick = direction === "BUY" ? b.low : b.high;
    const swept = s * (edge - wick) >= 0.1 * atr;
    const back = b.close <= range.high && b.close >= range.low;
    if (!swept || !back) continue;
    if (after.slice(k + 1).some((x) => s * (x.close - edge) < 0)) return null;
    return b;
  }
  return null;
}

/** CRT: sapuan ujung range candle H1 sebelumnya lalu kembali ke dalam; target alami sisi lain range. */
export function detectCrt(direction: Direction, pair: TfPair, c: DetectContext): SetupCandidate | null {
  const ctx = c.analysis.tfs[pair.context];
  const h1 = c.analysis.tfs.H1;
  const confCandles = c.candles[pair.confirm] ?? [];
  const hs = c.candles.H1 ?? [];
  if (!ctx || !h1 || hs.length < 2 || confCandles.length < 3) return null;
  const R = hs[hs.length - 1];
  const size = R.high - R.low;
  if (size < 0.5 * h1.atr || size > 3 * h1.atr) return null;
  const a = ctx.atr;
  const sweep = findCrtSweep(direction, R, c.candles[pair.context] ?? [], a);
  if (!sweep) return null;
  const s = sgn(direction);
  const edge = direction === "BUY" ? R.low : R.high;
  const zoneLow = direction === "BUY" ? edge - 0.1 * a : edge - 0.25 * a;
  const zoneHigh = direction === "BUY" ? edge + 0.25 * a : edge + 0.1 * a;
  const entryEdge = direction === "BUY" ? zoneHigh : zoneLow;
  if (s * (c.price - entryEdge) > c.config.maxDistanceAtr * a) return null;
  const target = direction === "BUY" ? R.high : R.low;
  const tp1Dist = pipsToPrice(planFor(c.config, pair.context).tp1Pips, c.config.spec);
  if (s * (target - entryEdge) < tp1Dist) return null; // tidak ada ruang sampai sisi lain range
  const wick = direction === "BUY" ? sweep.low : sweep.high;
  const invalidation = wick - s * 0.1 * a;
  if (s * (c.price - invalidation) <= 0) return null;
  const hhmm = (t: number) => new Date(t * 1000).toISOString().slice(11, 16);
  const reasons = [
    ...c.analysis.reasons,
    `CRT: range H1 ${hhmm(R.time)} UTC ${R.low.toFixed(2)}–${R.high.toFixed(2)}; candle ${pair.context} ${hhmm(sweep.time)} menyapu ${direction === "BUY" ? "low" : "high"} (ujung ${wick.toFixed(2)}) lalu menutup kembali di dalam range.`,
    `Area entry ${zoneLow.toFixed(2)}–${zoneHigh.toFixed(2)}; invalidasi di luar ujung sapuan ${invalidation.toFixed(2)}; target alami sisi lain range ${target.toFixed(2)} (TP tetap mengikuti rencana TF).`,
  ];
  return finalize(
    {
      strategy: "crt",
      direction,
      pair,
      ctx,
      conf: c.analysis.tfs[pair.confirm],
      zoneLow,
      zoneHigh,
      invalidation,
      levelTouches: 2,
      anchor: `crt:${R.time}:${sweep.time}`,
      confirmCandles: confCandles,
      confirmAfter: sweep.time + TF_SECONDS[pair.context],
      reasons,
    },
    c,
  );
}

/**
 * MSNR flip: swing high (BUY) / swing low (SELL) TF konteks dalam 30 bar terakhir yang ditembus close
 * ≥ 0,1 ATR (BOS) sehingga berganti peran, dan masih SEGAR: sejak break belum ada close kembali
 * melewatinya dan belum ada candle yang menyentuh zona retest (L + 0,2 ATR untuk BUY).
 */
export function findMsnrFlip(direction: Direction, swings: Swing[], bars: Candle[], atr: number): { level: Swing; breakIndex: number } | null {
  const s = sgn(direction);
  const n = bars.length - 1;
  const cands = swings.filter((sw) => sw.kind === (direction === "BUY" ? "high" : "low") && sw.index >= n - 30 && sw.index < n).sort((x, y) => y.index - x.index);
  for (const sw of cands) {
    const L = sw.price;
    let k = -1;
    for (let i = sw.index + 1; i <= n; i++) {
      if (s * (bars[i].close - L) >= 0.1 * atr) {
        k = i;
        break;
      }
    }
    if (k < 0) continue;
    const after = bars.slice(k + 1);
    const closedBack = after.some((b) => s * (b.close - L) < 0);
    const retested = after.some((b) => s * ((direction === "BUY" ? b.low : b.high) - (L + s * 0.2 * atr)) <= 0);
    if (closedBack || retested) continue;
    return { level: sw, breakIndex: k };
  }
  return null;
}

/** MSNR flip: retest pertama level A/V yang berganti peran, hanya searah tren TF bias besar (H1). */
export function detectMsnrFlip(direction: Direction, pair: TfPair, c: DetectContext): SetupCandidate | null {
  const ctx = c.analysis.tfs[pair.context];
  const cs = c.candles[pair.context] ?? [];
  const confCandles = c.candles[pair.confirm] ?? [];
  const major = c.config.biasTfs.major;
  if (!ctx || cs.length < 60 || confCandles.length < 3) return null;
  const majorBias = c.analysis.tfs[major]?.bias;
  // searah tren H1 saja (dua arah dicoba 20 Okt pagi, dikembalikan atas permintaan pengguna)
  if (majorBias !== dirBias(direction)) return null;
  const a = ctx.atr;
  const f = findMsnrFlip(direction, ctx.swings, cs, a);
  if (!f) return null;
  const s = sgn(direction);
  const L = f.level.price;
  const zoneLow = direction === "BUY" ? L - 0.15 * a : L - 0.2 * a;
  const zoneHigh = direction === "BUY" ? L + 0.2 * a : L + 0.15 * a;
  const edge = direction === "BUY" ? zoneHigh : zoneLow;
  if (s * (c.price - edge) > c.config.maxDistanceAtr * a) return null;
  const invalidation = L - s * invAtr(c, "msnr_flip", 0.5) * a;
  if (s * (c.price - invalidation) <= 0) return null;
  const brk = cs[f.breakIndex];
  const hhmm = (t: number) => new Date(t * 1000).toISOString().slice(11, 16);
  const reasons = [
    ...c.analysis.reasons,
    `MSNR flip: searah tren ${major} (${majorBias}); ${direction === "BUY" ? "swing high (A)" : "swing low (V)"} ${pair.context} ${L.toFixed(2)} ditembus close ${brk.close.toFixed(2)} (${hhmm(brk.time)} UTC) → ${direction === "BUY" ? "resistance jadi support" : "support jadi resistance"}, belum pernah di-retest (level segar).`,
    `Area retest ${zoneLow.toFixed(2)}–${zoneHigh.toFixed(2)}; invalidasi bila harga kembali ke ${invalidation.toFixed(2)}.`,
  ];
  return finalize(
    {
      strategy: "msnr_flip",
      direction,
      pair,
      ctx,
      conf: c.analysis.tfs[pair.confirm],
      zoneLow,
      zoneHigh,
      invalidation,
      levelTouches: 2,
      anchor: `msnr:${f.level.time}`,
      confirmCandles: confCandles,
      confirmAfter: brk.time + TF_SECONDS[pair.context],
      reasons,
    },
    c,
  );
}

/**
 * FVG (fair value gap): 3 candle a, b, c TF konteks dalam 20 bar terakhir — BUY: c.low > a.high (celah ≥ 0,15 dan ≤ 2 ATR),
 * candle b dorongan naik (badan ≥ 0,8 ATR). Masih SEGAR: sejak c belum ada candle yang masuk celah dan belum ada close
 * di bawah a.high. SELL cermin. Yang terbaru dipakai lebih dulu.
 */
export function findFvg(direction: Direction, bars: Candle[], atr: number): { low: number; high: number; index: number } | null {
  const n = bars.length - 1;
  for (let j = n - 1; j >= Math.max(1, n - 20); j--) {
    const a = bars[j - 1];
    const b = bars[j];
    const c = bars[j + 1];
    const low = direction === "BUY" ? a.high : c.high;
    const high = direction === "BUY" ? c.low : a.low;
    const gap = high - low;
    if (gap < 0.15 * atr || gap > 2 * atr) continue;
    if ((direction === "BUY" ? b.close - b.open : b.open - b.close) < 0.8 * atr) continue;
    const after = bars.slice(j + 2);
    const entered = after.some((x) => (direction === "BUY" ? x.low <= high : x.high >= low));
    const closedThrough = after.some((x) => (direction === "BUY" ? x.close < low : x.close > high));
    if (entered || closedThrough) continue;
    return { low, high, index: j };
  }
  return null;
}

/** FVG retest: retest pertama celah harga yang ditinggalkan candle dorongan; dua arah (searah maupun melawan tren H1). */
export function detectFvgRetest(direction: Direction, pair: TfPair, c: DetectContext): SetupCandidate | null {
  const ctx = c.analysis.tfs[pair.context];
  const cs = c.candles[pair.context] ?? [];
  const confCandles = c.candles[pair.confirm] ?? [];
  const major = c.config.biasTfs.major;
  if (!ctx || cs.length < 60 || confCandles.length < 3) return null;
  const a = ctx.atr;
  const f = findFvg(direction, cs, a);
  if (!f) return null;
  const s = sgn(direction);
  const edge = direction === "BUY" ? f.high : f.low;
  if (s * (c.price - edge) > c.config.maxDistanceAtr * a) return null;
  const invalidation = direction === "BUY" ? f.low - 0.25 * a : f.high + 0.25 * a;
  if (s * (c.price - invalidation) <= 0) return null;
  const impulse = cs[f.index];
  // BOS: candle dorongan menutup melewati swing lawan terakhir sebelum celah (hanya menambah skor struktur)
  const lastSwing = ctx.swings
    .filter((sw) => sw.kind === (direction === "BUY" ? "high" : "low") && sw.index < f.index)
    .sort((x, y) => y.index - x.index)[0];
  const bos = lastSwing != null && s * (impulse.close - lastSwing.price) > 0;
  const majorBias = c.analysis.tfs[major]?.bias;
  const withTrend = majorBias === dirBias(direction);
  const hhmm = (t: number) => new Date(t * 1000).toISOString().slice(11, 16);
  const reasons = [
    ...c.analysis.reasons,
    `FVG retest: ${withTrend ? `searah tren ${major} (${majorBias})` : majorBias === "ranging" ? `${major} ranging` : `melawan tren ${major} (${majorBias ?? "—"}) — skor tren 0`}; candle dorongan ${direction === "BUY" ? "naik" : "turun"} ${pair.context} (${hhmm(impulse.time)} UTC) meninggalkan celah ${f.low.toFixed(2)}–${f.high.toFixed(2)} yang belum pernah diisi${bos ? `, sekaligus menembus swing ${lastSwing!.price.toFixed(2)} (BOS)` : ""}.`,
    `Area retest = celah; invalidasi bila harga kembali ke ${invalidation.toFixed(2)}.`,
  ];
  return finalize(
    {
      strategy: "fvg_retest",
      direction,
      pair,
      ctx,
      conf: c.analysis.tfs[pair.confirm],
      zoneLow: f.low,
      zoneHigh: f.high,
      invalidation,
      levelTouches: bos ? 2 : 1,
      anchor: `fvg:${impulse.time}`,
      confirmCandles: confCandles,
      confirmAfter: cs[f.index + 1].time + TF_SECONDS[pair.context],
      reasons,
    },
    c,
  );
}

/**
 * Order Block: BOS terbaru dalam 30 bar TF konteks — candle pertama yang close menembus swing lawan terakhir ≥ 0,1 ATR
 * (BUY: swing high). OB = candle berlawanan arah terakhir (BUY: candle turun) maks 6 bar sebelum BOS; zona BUY =
 * low OB … puncak badan OB (SELL cermin), tinggi 0,1–1,5 ATR. Masih SEGAR: sejak BOS belum ada candle yang masuk zona.
 */
export function findOrderBlock(direction: Direction, bars: Candle[], swings: Swing[], atr: number): { zoneLow: number; zoneHigh: number; obIndex: number; bosIndex: number; level: number } | null {
  const s = sgn(direction);
  const n = bars.length - 1;
  const opp = swings.filter((x) => x.kind === (direction === "BUY" ? "high" : "low"));
  for (let k = n; k >= Math.max(6, n - 30); k--) {
    const sw = opp.filter((x) => x.index < k - 1).sort((x, y) => y.index - x.index)[0];
    if (!sw || s * (bars[k].close - sw.price) < 0.1 * atr || s * (bars[k - 1].close - sw.price) >= 0) continue;
    let j = k - 1;
    while (j >= Math.max(1, k - 6) && !(direction === "BUY" ? bars[j].close < bars[j].open : bars[j].close > bars[j].open)) j--;
    if (j < Math.max(1, k - 6)) continue; // tidak ada candle berlawanan sebelum dorongan → cari BOS sebelumnya
    const ob = bars[j];
    const zoneLow = direction === "BUY" ? ob.low : Math.min(ob.open, ob.close);
    const zoneHigh = direction === "BUY" ? Math.max(ob.open, ob.close) : ob.high;
    const h = zoneHigh - zoneLow;
    if (h < 0.1 * atr || h > 1.5 * atr) return null;
    if (bars.slice(k + 1).some((c) => (direction === "BUY" ? c.low <= zoneHigh : c.high >= zoneLow))) return null;
    return { zoneLow, zoneHigh, obIndex: j, bosIndex: k, level: sw.price };
  }
  return null;
}

/** Order Block retest (versi O2 pilihan pengguna 20 Okt 2026): BUY/SELL selama bias utama tidak berlawanan; entry limit di tepi zona. */
export function detectOrderBlock(direction: Direction, pair: TfPair, c: DetectContext): SetupCandidate | null {
  const ctx = c.analysis.tfs[pair.context];
  const cs = c.candles[pair.context] ?? [];
  const confCandles = c.candles[pair.confirm] ?? [];
  const major = c.config.biasTfs.major;
  if (!ctx || cs.length < 60 || confCandles.length < 3) return null;
  if (opposite(c.analysis.mainBias, direction)) return null;
  const a = ctx.atr;
  const f = findOrderBlock(direction, cs, ctx.swings, a);
  if (!f) return null;
  const s = sgn(direction);
  const edge = direction === "BUY" ? f.zoneHigh : f.zoneLow;
  // harga harus masih di luar zona (menunggu retest pertama) dan tidak terlalu jauh
  if (s * (c.price - edge) <= 0 || s * (c.price - edge) > c.config.maxDistanceAtr * a) return null;
  const obInv = invAtr(c, "order_block", 0.1);
  const invalidation = direction === "BUY" ? f.zoneLow - obInv * a : f.zoneHigh + obInv * a;
  const ob = cs[f.obIndex];
  const bos = cs[f.bosIndex];
  const majorBias = c.analysis.tfs[major]?.bias;
  const hhmm = (t: number) => new Date(t * 1000).toISOString().slice(11, 16);
  const reasons = [
    ...c.analysis.reasons,
    `Order Block: ${majorBias === dirBias(direction) ? `searah tren ${major}` : `${major} ${majorBias ?? "—"}, bias utama tidak berlawanan`}; close ${pair.context} ${hhmm(bos.time)} UTC menembus swing ${f.level.toFixed(2)} (BOS); candle ${direction === "BUY" ? "turun" : "naik"} terakhir sebelum dorongan (${hhmm(ob.time)} UTC) = zona ${f.zoneLow.toFixed(2)}–${f.zoneHigh.toFixed(2)}, belum pernah di-retest.`,
    `Entry limit di tepi zona; invalidasi bila harga kembali ke ${invalidation.toFixed(2)}.`,
  ];
  return finalize(
    {
      strategy: "order_block",
      direction,
      pair,
      ctx,
      conf: c.analysis.tfs[pair.confirm],
      zoneLow: f.zoneLow,
      zoneHigh: f.zoneHigh,
      invalidation,
      levelTouches: 2,
      anchor: `ob:${ob.time}`,
      confirmCandles: confCandles,
      confirmAfter: bos.time + TF_SECONDS[pair.context],
      reasons,
    },
    c,
  );
}

/**
 * Breakout kandang babi (20 Okt 2026): 4 candle H1 terakhir terkurung ≤ 2 ATR H1, lalu candle M15 terakhir menjadi
 * close PERTAMA di luar kotak (> 0,1 ATR M15 melewati tepi) dengan badan ≥ 0,5 ATR M15. Entry limit retest di tepi
 * kotak, SL/TP rencana M30; invalidasi bila harga masuk lagi 0,3 ATR M15 ke dalam kotak. Hanya pasangan konteks M30.
 * Uji candle nyata 30 Agu–19 Okt (searah momentum, aturan peluang terlewat): 35 trade 23W/12L +2.205 (+63/sinyal).
 */
export function detectChopBreakout(direction: Direction, pair: TfPair, c: DetectContext): SetupCandidate | null {
  if (pair.context !== "M30") return null;
  const rule = c.config.chopRanging ?? { bars: 4, maxAtr: 2 };
  const boxTf = rule.tf ?? c.config.biasTfs.major;
  const m = c.analysis.tfs[boxTf];
  const ctx = c.analysis.tfs[pair.context];
  // candle tembusan selalu M15 (seperti yang diuji), terlepas dari TF konfirmasi pasangan
  const conf = c.analysis.tfs.M15;
  const bars = c.candles.M15 ?? [];
  if (!m || !ctx || !conf || bars.length < 3) return null;
  const box = isBoxed(c.candles[boxTf] ?? [], m.atr, rule);
  if (!box) return null;
  const s = sgn(direction);
  const a = conf.atr;
  const edge = direction === "BUY" ? box.high : box.low;
  const b = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  if (!(s * (b.close - edge) > 0.1 * a) || s * (prev.close - edge) > 0) return null;
  if (s * (b.close - b.open) < 0.5 * a) return null;
  const zoneLow = direction === "BUY" ? edge - 0.2 * a : edge;
  const zoneHigh = direction === "BUY" ? edge : edge + 0.2 * a;
  const invalidation = edge - s * 0.3 * a;
  const hhmm = (t: number) => new Date(t * 1000).toISOString().slice(11, 16);
  const reasons = [
    ...c.analysis.reasons,
    `Breakout kandang babi: ${rule.bars} candle ${boxTf} terkurung ${box.low.toFixed(2)}–${box.high.toFixed(2)}; candle M15 ${hhmm(b.time)} UTC close ${b.close.toFixed(2)} ${direction === "BUY" ? "menembus ke atas" : "menembus ke bawah"} dengan badan ${(s * (b.close - b.open) / a).toFixed(2)} ATR.`,
    `Entry limit retest tepi kotak ${edge.toFixed(2)}; invalidasi bila harga masuk lagi ke ${invalidation.toFixed(2)}.`,
  ];
  return finalize(
    {
      strategy: "chop_breakout",
      direction,
      pair,
      ctx,
      conf,
      zoneLow,
      zoneHigh,
      invalidation,
      levelTouches: 2,
      anchor: `box:${box.low.toFixed(2)}-${box.high.toFixed(2)}`,
      confirmCandles: c.candles[pair.confirm] ?? bars,
      confirmAfter: b.time + TF_SECONDS.M15,
      reasons,
    },
    c,
  );
}

/**
 * Model entry SMC (22 Okt 2026): sapuan likuiditas → CHoCH → FVG dorongan. BUY: candle CHoCH `m` (dalam 24 bar
 * terakhir) adalah close PERTAMA di atas swing high terakhir H (≥ 0,1 ATR); di antara H dan m ada candle `k` yang
 * menyapu swing low sebelumnya ≥ 0,1 ATR (likuiditas jual diambil); di antara k dan m terbentuk FVG naik (celah
 * 0,1–2 ATR, candle tengah badan ≥ 0,5 ATR) yang belum diisi dan belum ditembus close. SELL cermin.
 */
export function findSmcChoch(
  direction: Direction,
  bars: Candle[],
  swings: Swing[],
  atr: number,
): { sweep: Candle; sweepLevel: number; choch: Candle; chochLevel: number; fvg: { low: number; high: number; index: number } } | null {
  const s = sgn(direction);
  const n = bars.length - 1;
  const highs = swings.filter((x) => x.kind === (direction === "BUY" ? "high" : "low"));
  const lows = swings.filter((x) => x.kind === (direction === "BUY" ? "low" : "high"));
  const ext = (b: Candle) => (direction === "BUY" ? b.low : b.high);
  for (let m = n; m >= Math.max(2, n - 24); m--) {
    const H = highs.filter((x) => x.index < m - 1).sort((x, y) => y.index - x.index)[0];
    if (!H || s * (bars[m].close - H.price) < 0.1 * atr || s * (bars[m - 1].close - H.price) >= 0) continue;
    // sapuan: ujung terjauh antara H dan CHoCH harus menembus swing lawan sebelumnya
    let k = -1;
    for (let i = H.index + 1; i < m; i++) if (k < 0 || s * (ext(bars[k]) - ext(bars[i])) > 0) k = i;
    if (k < 0) continue;
    const S = lows.filter((x) => x.index < k - 1 && x.index >= H.index - 30).sort((x, y) => y.index - x.index)[0];
    if (!S || s * (S.price - ext(bars[k])) < 0.1 * atr) continue;
    for (let j = Math.min(m, n - 1); j > k; j--) {
      const a = bars[j - 1];
      const b = bars[j];
      const c = bars[j + 1];
      const low = direction === "BUY" ? a.high : c.high;
      const high = direction === "BUY" ? c.low : a.low;
      if (high - low < 0.1 * atr || high - low > 2 * atr) continue;
      if (s * (b.close - b.open) < 0.5 * atr) continue;
      const after = bars.slice(j + 2);
      if (after.some((x) => (direction === "BUY" ? x.low <= high || x.close < low : x.high >= low || x.close > high))) continue;
      return { sweep: bars[k], sweepLevel: S.price, choch: bars[m], chochLevel: H.price, fvg: { low, high, index: j } };
    }
  }
  return null;
}

/** Model entry SMC: retest pertama FVG dorongan setelah sapuan likuiditas + CHoCH; dua arah (CHoCH = arah baru). */
export function detectSmcChoch(direction: Direction, pair: TfPair, c: DetectContext): SetupCandidate | null {
  const ctx = c.analysis.tfs[pair.context];
  const cs = c.candles[pair.context] ?? [];
  const confCandles = c.candles[pair.confirm] ?? [];
  if (!ctx || cs.length < 60 || confCandles.length < 3) return null;
  const a = ctx.atr;
  const f = findSmcChoch(direction, cs, ctx.swings, a);
  if (!f) return null;
  const s = sgn(direction);
  const edge = direction === "BUY" ? f.fvg.high : f.fvg.low;
  if (s * (c.price - edge) <= 0 || s * (c.price - edge) > c.config.maxDistanceAtr * a) return null;
  // ide batal bila ujung sapuan ditembus ATAU celah ditembus jauh — dipakai yang lebih dekat ke entry
  const bySweep = (direction === "BUY" ? f.sweep.low : f.sweep.high) - s * 0.1 * a;
  const byGap = (direction === "BUY" ? f.fvg.low : f.fvg.high) - s * invAtr(c, "smc_choch", 0.3) * a;
  const invalidation = direction === "BUY" ? Math.max(bySweep, byGap) : Math.min(bySweep, byGap);
  const hhmm = (t: number) => new Date(t * 1000).toISOString().slice(11, 16);
  const reasons = [
    ...c.analysis.reasons,
    `SMC: candle ${pair.context} ${hhmm(f.sweep.time)} UTC menyapu ${direction === "BUY" ? "swing low" : "swing high"} ${f.sweepLevel.toFixed(2)} (likuiditas diambil), lalu close ${hhmm(f.choch.time)} UTC menembus ${direction === "BUY" ? "swing high" : "swing low"} ${f.chochLevel.toFixed(2)} (CHoCH).`,
    `Dorongan meninggalkan FVG ${f.fvg.low.toFixed(2)}–${f.fvg.high.toFixed(2)} yang belum diisi → entry limit di tepi celah; invalidasi ${invalidation.toFixed(2)}.`,
  ];
  return finalize(
    {
      strategy: "smc_choch",
      direction,
      pair,
      ctx,
      conf: c.analysis.tfs[pair.confirm],
      zoneLow: f.fvg.low,
      zoneHigh: f.fvg.high,
      invalidation,
      levelTouches: 3,
      anchor: `smc:${f.choch.time}:${cs[f.fvg.index].time}`,
      confirmCandles: confCandles,
      confirmAfter: cs[f.fvg.index + 1].time + TF_SECONDS[pair.context],
      reasons,
    },
    c,
  );
}

/** candle terakhir terkurung dalam kotak ≤ maxAtr × ATR ("kandang babi") */
export function isBoxed(bars: Candle[], atr: number, rule: { bars: number; maxAtr: number }): { high: number; low: number } | null {
  const b = bars.slice(-rule.bars);
  if (b.length < rule.bars || !(atr > 0)) return null;
  const high = Math.max(...b.map((x) => x.high));
  const low = Math.min(...b.map((x) => x.low));
  return high - low <= rule.maxAtr * atr ? { high, low } : null;
}

/** konteks S&D saat H1 berlabel tren tetapi harga terkurung: H1 (dan bias utama) diperlakukan ranging */
export function chopRangingContext(c: DetectContext): DetectContext | null {
  const rule = c.config.chopRanging;
  const major = c.config.biasTfs.major;
  const m = c.analysis.tfs[major];
  if (!rule || !m || m.bias === "ranging") return null;
  const boxTf = rule.tf ?? major;
  const bt = c.analysis.tfs[boxTf];
  if (!bt) return null;
  const box = isBoxed(c.candles[boxTf] ?? [], bt.atr, rule);
  if (!box) return null;
  const note = `${major} ${m.bias} tetapi ${rule.bars} candle ${boxTf} terakhir terkurung ${box.low.toFixed(2)}–${box.high.toFixed(2)} (≤ ${rule.maxAtr} ATR, "kandang babi") → diperlakukan ranging untuk Supply/Demand reversal.`;
  return {
    ...c,
    analysis: { ...c.analysis, mainBias: "ranging", tfs: { ...c.analysis.tfs, [major]: { ...m, bias: "ranging" } }, reasons: [...c.analysis.reasons, note] },
  };
}

const DETECTORS: [StrategyId, (direction: Direction, pair: TfPair, c: DetectContext) => SetupCandidate | null][] = [
  ["trend_pullback", detectTrendPullback],
  ["breakout_retest", detectBreakoutRetest],
  ["liquidity_sweep", detectLiquiditySweep],
  ["sd_reversal", detectSdReversal],
  ["crt", detectCrt],
  ["msnr_flip", detectMsnrFlip],
  ["fvg_retest", detectFvgRetest],
  ["order_block", detectOrderBlock],
  ["chop_breakout", detectChopBreakout],
  ["smc_choch", detectSmcChoch],
];

function runDetectors(c: DetectContext, only: (s: StrategyId) => boolean): SetupCandidate[] {
  const out: SetupCandidate[] = [];
  const sdCtx = c.config.strategies.includes("sd_reversal") ? (chopRangingContext(c) ?? c) : c;
  for (const pair of c.config.pairs) {
    for (const dir of ["BUY", "SELL"] as Direction[]) {
      for (const [id, detect] of DETECTORS) {
        if (!c.config.strategies.includes(id) || !only(id)) continue;
        if (c.config.contexts?.[id] && !c.config.contexts[id]!.includes(pair.context)) continue;
        const x = detect(dir, pair, id === "sd_reversal" ? sdCtx : c);
        if (x) out.push(x);
      }
    }
  }
  return out;
}

/** arah momentum: BUY bila EMA cepat di atas EMA lambat pada candle tertutup TF momentum, selain itu SELL */
export function momentumDirection(bars: Candle[], fast: number, slow: number): { direction: Direction; fast: number; slow: number } | null {
  const closes = bars.slice(-150).map((b) => b.close);
  if (closes.length < slow) return null;
  const ema = (n: number) => {
    const k = 2 / (n + 1);
    let e = closes[0];
    for (let i = 1; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
    return e;
  };
  const f = ema(fast);
  const sl = ema(slow);
  return { direction: f > sl ? "BUY" : "SELL", fast: f, slow: sl };
}

export function detectAll(c: DetectContext): SetupCandidate[] {
  let out = runDetectors(c, () => true);
  const rule = c.config.direction;
  // arah dari setup, bukan dipaksa tren besar: strategi twoWay juga dicari melawan bias utama (dideteksi seperti bias
  // utama netral, jadi skor tren = ranging); hanya kandidat yang melawan bias & belum ada yang ditambahkan
  if (rule?.twoWay.length && c.analysis.mainBias !== "ranging") {
    const have = new Set(out.map((x) => x.identityKey));
    const neutral: DetectContext = { ...c, analysis: { ...c.analysis, mainBias: "ranging" } };
    for (const x of runDetectors(neutral, (id) => rule.twoWay.includes(id) && id !== "sd_reversal")) {
      if (!opposite(c.analysis.mainBias, x.direction) || have.has(x.identityKey)) continue;
      x.reasons.push(`Melawan bias utama ${c.analysis.mainBias}: diizinkan karena arah ditentukan setup & momentum, bukan tren besar.`);
      out.push(x);
    }
  }
  // momentum TF kecil menentukan arah: kandidat yang berlawanan tidak dibuat (bisa muncul lagi saat momentum searah);
  // strategi di `skip` (pembalikan: masuk justru saat momentum kecil berlawanan) tidak disaring
  if (rule?.momentum) {
    const mom = rule.momentum;
    const m = momentumDirection(c.candles[mom.tf] ?? [], mom.fast, mom.slow);
    if (m) {
      const skip = mom.skip ?? [];
      out = out.filter((x) => x.direction === m.direction || skip.includes(x.strategy));
      const note = `Momentum ${mom.tf} ${m.direction === "BUY" ? "naik" : "turun"}: EMA${mom.fast} ${m.fast.toFixed(2)} ${m.direction === "BUY" ? ">" : "<"} EMA${mom.slow} ${m.slow.toFixed(2)} → hanya ${m.direction}.`;
      for (const x of out)
        x.reasons.push(x.direction === m.direction ? note : `Momentum ${mom.tf} berlawanan, tetapi strategi pembalikan ini tidak disaring momentum.`);
    }
  }
  return out.filter((x) => x.score.total >= c.config.engineMinScore);
}
