import type { AnalysisStatus, Candle, MarketBias, Timeframe } from "./types.ts";
import { atr, ema, rsi } from "./indicators.ts";
import { buildLevels, findSwings, readStructure, type Level, type StructureRead, type Swing } from "./structure.ts";

export interface TfAnalysis {
  tf: Timeframe;
  bars: number;
  lastTime: number;
  lastClose: number;
  ema20: number;
  ema50: number;
  ema200: number;
  /** kemiringan EMA50 selama 5 bar, dalam satuan ATR */
  ema50SlopeAtr: number;
  rsi: number;
  rsiPrev: number;
  atr: number;
  structure: StructureRead;
  swings: Swing[];
  levels: Level[];
  bias: MarketBias;
  reasons: string[];
}

export const MIN_BARS_FOR_ANALYSIS = 60;

/** Analisis satu timeframe. `candles` HARUS sudah berisi candle tertutup saja. */
export function analyzeTimeframe(tf: Timeframe, candles: Candle[]): TfAnalysis | null {
  if (candles.length < MIN_BARS_FOR_ANALYSIS) return null;
  const closes = candles.map((c) => c.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const e200 = ema(closes, 200);
  const r = rsi(closes, 14);
  const a = atr(candles, 14);
  const n = candles.length - 1;
  const atrNow = a[n];
  const slope = Number.isFinite(e50[n - 5]) ? (e50[n] - e50[n - 5]) / (atrNow || 1) : 0;
  const swings = findSwings(candles.slice(-150), 3, 3).map((s) => ({ ...s, index: s.index + Math.max(0, candles.length - 150) }));
  const structure = readStructure(swings);
  const close = closes[n];
  const levels = buildLevels(swings, close, Math.max(atrNow * 0.25, 1e-6));

  const reasons: string[] = [];
  reasons.push(`${tf}: ${structure.label}.`);
  const emaUp = e20[n] > e50[n];
  const emaDown = e20[n] < e50[n];
  if (Number.isFinite(e200[n])) {
    reasons.push(`${tf}: harga ${close > e200[n] ? "di atas" : "di bawah"} EMA200 (${e200[n].toFixed(2)}).`);
  } else {
    reasons.push(`${tf}: EMA200 belum tersedia (${candles.length} bar < 200).`);
  }
  reasons.push(`${tf}: EMA20 ${emaUp ? ">" : "<"} EMA50, kemiringan EMA50 ${slope >= 0 ? "+" : ""}${slope.toFixed(2)} ATR/5 bar.`);

  let bias: MarketBias = "ranging";
  if (structure.bias === "bullish" && close > e50[n] && emaUp) bias = "bullish";
  else if (structure.bias === "bearish" && close < e50[n] && emaDown) bias = "bearish";
  else if (structure.bias === "ranging" && emaUp && close > e20[n] && slope > 0.3 && close > (e200[n] || -Infinity)) bias = "bullish";
  else if (structure.bias === "ranging" && emaDown && close < e20[n] && slope < -0.3 && close < (e200[n] || Infinity)) bias = "bearish";

  return {
    tf,
    bars: candles.length,
    lastTime: candles[n].time,
    lastClose: close,
    ema20: e20[n],
    ema50: e50[n],
    ema200: e200[n],
    ema50SlopeAtr: slope,
    rsi: r[n],
    rsiPrev: r[n - 1],
    atr: atrNow,
    structure,
    swings,
    levels,
    bias,
    reasons,
  };
}

export interface MarketView {
  nowSec: number;
  /** candle tertutup per timeframe */
  candles: Partial<Record<Timeframe, Candle[]>>;
}

export interface MultiTfAnalysis {
  asOf: number;
  tfs: Partial<Record<Timeframe, TfAnalysis>>;
  mainBias: MarketBias;
  /** TF besar searah dengan TF pendukung */
  strongBias: boolean;
  reasons: string[];
}

/**
 * Bias utama dari TF besar (major) + TF pendukung (minor), default H1 + M30:
 *  - keduanya searah → bias kuat
 *  - minor berarah, major ranging → bias moderat searah minor
 *  - selain itu (konflik / minor ranging) → ranging
 */
export function analyzeMarket(
  view: MarketView,
  tfs: Timeframe[] = ["H1", "M30", "M15"],
  bias: { major: Timeframe; minor: Timeframe } = { major: "H1", minor: "M30" },
): MultiTfAnalysis {
  const out: Partial<Record<Timeframe, TfAnalysis>> = {};
  for (const tf of new Set([...tfs, bias.major, bias.minor])) {
    const a = analyzeTimeframe(tf, view.candles[tf] ?? []);
    if (a) out[tf] = a;
  }
  const M = bias.major;
  const m = bias.minor;
  const big = out[M]?.bias;
  const small = out[m]?.bias;
  const reasons: string[] = [];
  let mainBias: MarketBias = "ranging";
  let strong = false;
  if (!big || !small) {
    reasons.push(`Data ${M}/${m} belum cukup untuk menentukan bias utama.`);
  } else if (small !== "ranging" && big === small) {
    mainBias = small;
    strong = true;
    reasons.push(`Bias utama ${small === "bullish" ? "bullish" : "bearish"}: ${M} dan ${m} searah.`);
  } else if (small !== "ranging" && big === "ranging") {
    mainBias = small;
    reasons.push(`Bias utama ${small} (moderat): ${m} berarah, ${M} masih ranging.`);
  } else if (small !== "ranging" && big !== "ranging" && small !== big) {
    reasons.push(`Konflik: ${M} ${big}, ${m} ${small} → diperlakukan ranging.`);
  } else {
    reasons.push(`${m} ranging${big !== "ranging" ? `, ${M} ${big}` : ""} → belum ada bias utama.`);
  }
  return { asOf: view.nowSec, tfs: out, mainBias, strongBias: strong, reasons };
}

/** Status analisis ringkas. Data tidak valid → "Tidak ada setup valid" (sinyal baru diblokir). */
export function summarizeStatus(a: MultiTfAnalysis, qualityOk: boolean, hasAwaiting: boolean): AnalysisStatus {
  if (!qualityOk) return "no_valid_setup";
  if (hasAwaiting) return "awaiting_confirmation";
  return a.mainBias;
}

export const ANALYSIS_STATUS_LABEL: Record<AnalysisStatus, string> = {
  bullish: "Bullish",
  bearish: "Bearish",
  ranging: "Ranging",
  awaiting_confirmation: "Menunggu konfirmasi",
  no_valid_setup: "Tidak ada setup valid",
};
