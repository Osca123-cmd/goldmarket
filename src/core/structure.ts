import type { Candle, MarketBias } from "./types.ts";

export interface Swing {
  index: number;
  time: number;
  price: number;
  kind: "high" | "low";
}

/**
 * Pivot fraktal: high[i] lebih tinggi dari `left` bar sebelum dan `right` bar
 * sesudah. Swing baru dikonfirmasi setelah `right` bar berikutnya ditutup —
 * jadi pada bar terakhir tidak ada look-ahead.
 */
export function findSwings(candles: Candle[], left = 3, right = 3): Swing[] {
  const out: Swing[] = [];
  for (let i = left; i < candles.length - right; i++) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (candles[j].high >= c.high && (j > i || candles[j].high > c.high)) isHigh = false;
      if (candles[j].low <= c.low && (j > i || candles[j].low < c.low)) isLow = false;
    }
    if (isHigh) out.push({ index: i, time: c.time, price: c.high, kind: "high" });
    if (isLow) out.push({ index: i, time: c.time, price: c.low, kind: "low" });
  }
  return out;
}

export interface StructureRead {
  bias: MarketBias;
  label: string;
  lastHigh?: Swing;
  prevHigh?: Swing;
  lastLow?: Swing;
  prevLow?: Swing;
}

/** Klasifikasi HH/HL (bullish), LH/LL (bearish), selain itu ranging. */
export function readStructure(swings: Swing[]): StructureRead {
  const highs = swings.filter((s) => s.kind === "high");
  const lows = swings.filter((s) => s.kind === "low");
  const lastHigh = highs[highs.length - 1];
  const prevHigh = highs[highs.length - 2];
  const lastLow = lows[lows.length - 1];
  const prevLow = lows[lows.length - 2];
  if (!lastHigh || !prevHigh || !lastLow || !prevLow) {
    return { bias: "ranging", label: "Swing belum cukup untuk membaca struktur", lastHigh, prevHigh, lastLow, prevLow };
  }
  const hh = lastHigh.price > prevHigh.price;
  const hl = lastLow.price > prevLow.price;
  const lh = lastHigh.price < prevHigh.price;
  const ll = lastLow.price < prevLow.price;
  if (hh && hl) return { bias: "bullish", label: "Higher high & higher low", lastHigh, prevHigh, lastLow, prevLow };
  if (lh && ll) return { bias: "bearish", label: "Lower high & lower low", lastHigh, prevHigh, lastLow, prevLow };
  const parts = [hh ? "HH" : lh ? "LH" : "EH", hl ? "HL" : ll ? "LL" : "EL"];
  return { bias: "ranging", label: `Struktur campuran (${parts.join(" / ")})`, lastHigh, prevHigh, lastLow, prevLow };
}

export interface Level {
  price: number;
  touches: number;
  kind: "support" | "resistance";
  lastTime: number;
}

/**
 * Kelompokkan swing menjadi level S/R. Toleransi = `tol` (harga), biasanya
 * 0.25 × ATR. Level di bawah harga = support, di atas = resistance.
 */
export function buildLevels(swings: Swing[], refPrice: number, tol: number): Level[] {
  const clusters: { sum: number; n: number; lastTime: number }[] = [];
  const sorted = [...swings].sort((a, b) => a.price - b.price);
  for (const s of sorted) {
    const c = clusters[clusters.length - 1];
    if (c && Math.abs(s.price - c.sum / c.n) <= tol) {
      c.sum += s.price;
      c.n += 1;
      c.lastTime = Math.max(c.lastTime, s.time);
    } else {
      clusters.push({ sum: s.price, n: 1, lastTime: s.time });
    }
  }
  return clusters
    .map((c) => {
      const price = c.sum / c.n;
      return { price, touches: c.n, lastTime: c.lastTime, kind: price <= refPrice ? "support" : "resistance" } as Level;
    })
    .sort((a, b) => b.price - a.price);
}

export function nearestLevel(levels: Level[], price: number, kind: Level["kind"]): Level | undefined {
  const cands = levels.filter((l) => l.kind === kind);
  if (kind === "support") return cands.filter((l) => l.price <= price).sort((a, b) => b.price - a.price)[0];
  return cands.filter((l) => l.price >= price).sort((a, b) => a.price - b.price)[0];
}

// --- Pola konfirmasi candle (hanya candle tertutup) ---

export function isBullishConfirmation(prev: Candle, c: Candle): string | null {
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low || 1e-9;
  const lowerWick = Math.min(c.open, c.close) - c.low;
  if (c.close > c.open && prev.close < prev.open && c.close >= prev.open && c.open <= prev.close) return "Bullish engulfing";
  if (lowerWick >= 2 * body && lowerWick / range >= 0.55 && c.close >= c.low + range * 0.6) return "Pin bar penolakan bawah";
  if (c.close > c.open && body / range >= 0.6 && c.close > prev.high) return "Candle momentum menutup di atas high sebelumnya";
  return null;
}

export function isBearishConfirmation(prev: Candle, c: Candle): string | null {
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low || 1e-9;
  const upperWick = c.high - Math.max(c.open, c.close);
  if (c.close < c.open && prev.close > prev.open && c.close <= prev.open && c.open >= prev.close) return "Bearish engulfing";
  if (upperWick >= 2 * body && upperWick / range >= 0.55 && c.close <= c.high - range * 0.6) return "Pin bar penolakan atas";
  if (c.close < c.open && body / range >= 0.6 && c.close < prev.low) return "Candle momentum menutup di bawah low sebelumnya";
  return null;
}
