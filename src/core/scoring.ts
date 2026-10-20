import type { Direction, MarketBias } from "./types.ts";

/**
 * Skor kualitas berbasis aturan (0–100). BUKAN probabilitas menang.
 *
 * Komponen & bobot:
 *  - Keselarasan tren        25
 *  - Struktur & level        25
 *  - Konfirmasi candle       20
 *  - Momentum (RSI 14)       15
 *  - Volatilitas & biaya     15
 *
 * Syarat wajib (gate) dievaluasi terpisah di strategies.ts; skor tinggi tidak
 * bisa menutupi gate yang gagal.
 */
export const SCORE_WEIGHTS = { trend: 25, structure: 25, candle: 20, momentum: 15, volatilityCost: 15 } as const;

export interface ScoreInput {
  direction: Direction;
  mainBias: MarketBias;
  strongBias: boolean;
  /** bias TF info (H4): hanya MENAMBAH poin tren bila searah, tidak pernah mengurangi */
  infoBias?: MarketBias;
  infoTf?: string;
  /** jumlah sentuhan level acuan (support/resistance/area) */
  levelTouches: number;
  hasStructuralInvalidation: boolean;
  /** tidak ada level lawan sebelum TP1 */
  roomToTp1: boolean;
  confirmed: boolean;
  rsi: number;
  rsiPrev: number;
  slAtrContext: number;
  spreadPips: number;
  slPips: number;
}

export interface ScoreBreakdown {
  total: number;
  components: { key: keyof typeof SCORE_WEIGHTS; label: string; points: number; max: number; note: string }[];
}

export function scoreSetup(i: ScoreInput): ScoreBreakdown {
  const dirBias: MarketBias = i.direction === "BUY" ? "bullish" : "bearish";

  let trend = 0;
  let trendNote = "Bias utama tidak searah";
  if (i.mainBias === dirBias && i.strongBias) {
    trend = 25;
    trendNote = "H1 & M30 searah dengan setup";
  } else if (i.mainBias === dirBias) {
    trend = 18;
    trendNote = "M30 searah, H1 netral";
  } else if (i.mainBias === "ranging") {
    trend = 8;
    trendNote = "Bias utama ranging";
  }
  // bonus TF info (H4): +5 bila searah, maks 25 — skor tidak pernah turun karena H4
  if (i.infoBias === dirBias) {
    trend = Math.min(SCORE_WEIGHTS.trend, trend + 5);
    trendNote += `; ${i.infoTf ?? "H4"} juga searah`;
  }

  let structure = i.hasStructuralInvalidation ? 10 : 0;
  structure += i.levelTouches >= 3 ? 10 : i.levelTouches >= 2 ? 7 : i.levelTouches >= 1 ? 3 : 0;
  structure += i.roomToTp1 ? 5 : 0;
  const structureNote = `${i.levelTouches} sentuhan level; ${i.roomToTp1 ? "ruang ke TP1 bersih" : "ada level lawan sebelum TP1"}`;

  const candle = i.confirmed ? 20 : 0;

  let momentum = 0;
  let momentumNote = `RSI ${Number.isFinite(i.rsi) ? i.rsi.toFixed(1) : "—"}`;
  if (Number.isFinite(i.rsi)) {
    const rising = i.rsi > i.rsiPrev;
    if (i.direction === "BUY") {
      if (i.rsi > 75) momentumNote += " (jenuh beli)";
      else {
        momentum += i.rsi >= 45 && i.rsi <= 68 ? 10 : i.rsi >= 40 ? 5 : 0;
        momentum += rising ? 5 : 0;
      }
    } else if (i.rsi < 25) momentumNote += " (jenuh jual)";
    else {
      momentum += i.rsi >= 32 && i.rsi <= 55 ? 10 : i.rsi <= 60 ? 5 : 0;
      momentum += !rising ? 5 : 0;
    }
    momentumNote += rising ? ", naik" : ", turun";
  }

  let vol = 0;
  if (i.slAtrContext >= 1 && i.slAtrContext <= 3) vol += 8;
  else if (i.slAtrContext >= 0.75 && i.slAtrContext < 1) vol += 4;
  const spreadRatio = i.slPips > 0 ? i.spreadPips / i.slPips : 1;
  vol += spreadRatio <= 0.1 ? 7 : spreadRatio <= 0.2 ? 3 : 0;
  const volNote = `SL = ${i.slAtrContext.toFixed(2)}× ATR konteks; spread ${(spreadRatio * 100).toFixed(0)}% dari SL`;

  const components: ScoreBreakdown["components"] = [
    { key: "trend", label: "Keselarasan tren", points: trend, max: 25, note: trendNote },
    { key: "structure", label: "Struktur & level", points: structure, max: 25, note: structureNote },
    { key: "candle", label: "Konfirmasi candle", points: candle, max: 20, note: i.confirmed ? "Candle konfirmasi tertutup" : "Belum ada candle konfirmasi" },
    { key: "momentum", label: "Momentum", points: momentum, max: 15, note: momentumNote },
    { key: "volatilityCost", label: "Volatilitas & biaya", points: vol, max: 15, note: volNote },
  ];
  return { total: components.reduce((a, c) => a + c.points, 0), components };
}
