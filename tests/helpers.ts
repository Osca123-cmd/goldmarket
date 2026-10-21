import type { Candle, Timeframe } from "../src/core/types.ts";
import { TF_SECONDS } from "../src/core/types.ts";
import { barOverlapsMarket, demoCandle } from "../src/core/providers.ts";

/** Candle demo deterministik yang berakhir pada bar berisi `endSec` (bar terakhir masih berjalan). */
export function demoSeries(tf: Timeframe, endSec: number, count: number): Candle[] {
  const step = TF_SECONDS[tf];
  const out: Candle[] = [];
  for (let t = endSec - (endSec % step); out.length < count; t -= step) {
    if (step < 86400 && !barOverlapsMarket(t, step)) continue;
    out.unshift(demoCandle(tf, t));
  }
  return out;
}

export function demoView(endSec: number) {
  return {
    H4: demoSeries("H4", endSec, 300),
    H1: demoSeries("H1", endSec, 300),
    M30: demoSeries("M30", endSec, 300),
    M15: demoSeries("M15", endSec, 300),
    M5: demoSeries("M5", endSec, 300),
  } as Partial<Record<Timeframe, Candle[]>>;
}

/** susunan TF lama (bias H1+M30, info H4, kotak di TF bias) untuk tes pipeline yang dirancang di atas data demo itu */
export const LEGACY_TF = { biasTfs: { major: "H1", minor: "M30" }, infoTf: "H4", chopRanging: { bars: 4, maxAtr: 2 } } as const;
