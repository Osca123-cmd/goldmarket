import type { Candle, Direction, Timeframe } from "./types.ts";
import type { MultiTfAnalysis } from "./analysis.ts";
import type { Level } from "./structure.ts";

/**
 * Sentuhan pertama level S/R (23 Okt 2026) untuk strategi S/R Market Entry. BUY di support (SELL cermin):
 * candle TF konteks terakhir menyentuh zona level (low ≤ L + 0,15 ATR) tetapi tidak menutup jauh di bawahnya
 * (close ≥ L − 0,15 ATR); candle sebelumnya belum menyentuh zona (sentuhan pertama); 3 candle sebelumnya masih di
 * atas level (close > L + 0,3 ATR) — harga datang dari sisi yang benar. Level = cluster swing ≥ 2 sentuhan
 * (`buildLevels`). Hanya candle tertutup.
 */
export function findSrTouch(direction: Direction, tf: Timeframe, analysis: MultiTfAnalysis, candles: Partial<Record<Timeframe, Candle[]>>): { level: Level; bar: Candle } | null {
  const ctx = analysis.tfs[tf];
  const bars = candles[tf] ?? [];
  const n = bars.length - 1;
  if (!ctx || n < 30 || !(ctx.atr > 0)) return null;
  const a = ctx.atr;
  const s = direction === "BUY" ? 1 : -1;
  const b = bars[n];
  const prev = bars[n - 1];
  const before = bars[n - 3];
  const ext = (c: Candle) => (direction === "BUY" ? c.low : c.high);
  const touching = (c: Candle, L: number) => s * (ext(c) - L) <= 0.15 * a;
  const level = ctx.levels
    .filter((l) => l.touches >= 2)
    .filter((l) => touching(b, l.price) && s * (b.close - l.price) >= -0.15 * a && !touching(prev, l.price) && s * (before.close - l.price) > 0.3 * a)
    .sort((x, y) => Math.abs(ext(b) - x.price) - Math.abs(ext(b) - y.price))[0];
  return level ? { level, bar: b } : null;
}
