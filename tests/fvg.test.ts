import { describe, expect, it } from "vitest";
import { detectAll, findFvg } from "../src/core/strategies.ts";
import { analyzeMarket } from "../src/core/analysis.ts";
import { closedAsOf } from "../src/core/dataQuality.ts";
import { analysisTfs, mergeConfig } from "../src/core/config.ts";
import { demoPrice } from "../src/core/providers.ts";
import type { Candle, Timeframe } from "../src/core/types.ts";
import { demoView } from "./helpers.ts";

const atr = 2;
const bar = (i: number, open: number, high: number, low: number, close: number): Candle => ({ time: i * 900, open, high, low, close });
// 30 bar datar 4100–4102; index 26 = a, 27 = dorongan b, 28 = c; celah BUY 4102–4104
const up = () => {
  const bars = Array.from({ length: 30 }, (_, i) => bar(i, 4101, 4102, 4100, 4101));
  bars[26] = bar(26, 4100.5, 4102, 4100, 4101.8);
  bars[27] = bar(27, 4102, 4106.5, 4101.8, 4106);
  bars[28] = bar(28, 4106, 4108, 4104, 4107);
  bars[29] = bar(29, 4107, 4109, 4105, 4108);
  return bars;
};

describe("FVG retest: celah harga segar yang ditinggalkan candle dorongan", () => {
  it("BUY: celah a.high–c.low segar terdeteksi", () => {
    expect(findFvg("BUY", up(), atr)).toEqual({ low: 4102, high: 4104, index: 27 });
  });
  it("celah sudah dimasuki candle berikutnya → bukan retest pertama", () => {
    const bars = up();
    bars[29] = bar(29, 4107, 4108, 4103.5, 4106);
    expect(findFvg("BUY", bars, atr)).toBeNull();
  });
  it("candle dorongan lemah (badan < 0,8 ATR) → bukan FVG", () => {
    const bars = up();
    bars[27] = bar(27, 4104.6, 4106.5, 4101.8, 4106);
    expect(findFvg("BUY", bars, atr)).toBeNull();
  });
  it("celah terlalu kecil (< 0,15 ATR) → bukan FVG", () => {
    const bars = up();
    bars[28] = bar(28, 4106, 4108, 4102.2, 4107);
    bars[29] = bar(29, 4107, 4109, 4102.25, 4108);
    expect(findFvg("BUY", bars, atr)).toBeNull();
  });
  it("SELL: cermin (celah c.high–a.low)", () => {
    const bars = Array.from({ length: 30 }, (_, i) => bar(i, 4101, 4102, 4100, 4101));
    bars[26] = bar(26, 4101.5, 4102, 4100, 4100.2);
    bars[27] = bar(27, 4100, 4100.2, 4095.5, 4096);
    bars[28] = bar(28, 4096, 4098, 4094, 4095);
    bars[29] = bar(29, 4095, 4097, 4093, 4094);
    expect(findFvg("SELL", bars, atr)).toEqual({ low: 4098, high: 4100, index: 27 });
  });
  it("detectAll (fvg_retest) di data demo: SL/TP rencana TF, tidak pernah melawan bias utama", () => {
    const cfg = mergeConfig({ strategies: ["fvg_retest"] });
    let found = 0;
    for (let t = Date.parse("2026-07-01T00:00:00Z") / 1000; t < Date.parse("2026-07-15T00:00:00Z") / 1000; t += 1800) {
      const raw = demoView(t);
      const closed: Partial<Record<Timeframe, Candle[]>> = {};
      for (const tf of Object.keys(raw) as Timeframe[]) closed[tf] = closedAsOf(raw[tf] ?? [], tf, t);
      const analysis = analyzeMarket({ nowSec: t, candles: closed }, analysisTfs(cfg), cfg.biasTfs);
      for (const c of detectAll({ analysis, candles: closed, price: demoPrice(t / 60), spreadPips: 3, nowSec: t, dataTime: t, config: cfg })) {
        expect(c.strategy).toBe("fvg_retest");
        expect(c.slPips).toBe(cfg.planByTf[c.timeframe]!.slPips);
        const against = analysis.mainBias === (c.direction === "BUY" ? "bearish" : "bullish");
        // melawan H1 hanya bila bias utama tidak berlawanan (M30 tidak ikut searah H1)
        expect(against).toBe(false);
        found++;
      }
    }
    expect(found).toBeGreaterThan(0);
  }, 180000);
});
