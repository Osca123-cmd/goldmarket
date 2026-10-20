import { describe, expect, it } from "vitest";
import { detectAll, findMsnrFlip } from "../src/core/strategies.ts";
import { analyzeMarket } from "../src/core/analysis.ts";
import { closedAsOf } from "../src/core/dataQuality.ts";
import { analysisTfs, mergeConfig } from "../src/core/config.ts";
import { demoPrice } from "../src/core/providers.ts";
import type { Swing } from "../src/core/structure.ts";
import type { Candle, Timeframe } from "../src/core/types.ts";
import { demoView } from "./helpers.ts";

const atr = 2;
const bar = (i: number, low: number, high: number, close: number): Candle => ({ time: i * 900, open: (low + high) / 2, high, low, close });
// 40 bar datar 4100–4104, swing high 4105 di index 30, break di index 34
const base = () => Array.from({ length: 40 }, (_, i) => bar(i, 4100, 4104, 4102));
const swingHigh: Swing = { index: 30, time: 30 * 900, price: 4105, kind: "high" };
const swingLow: Swing = { index: 30, time: 30 * 900, price: 4099, kind: "low" };

describe("MSNR flip: level A/V yang berganti peran, retest pertama", () => {
  it("BUY: swing high ditembus close ≥ 0,1 ATR dan belum di-retest", () => {
    const bars = base();
    bars[34] = bar(34, 4104, 4107, 4106.5);
    for (let i = 35; i < 40; i++) bars[i] = bar(i, 4106, 4109, 4108);
    expect(findMsnrFlip("BUY", [swingHigh], bars, atr)).toEqual({ level: swingHigh, breakIndex: 34 });
  });
  it("sudah pernah di-retest (low menyentuh L + 0,2 ATR) → bukan level segar", () => {
    const bars = base();
    bars[34] = bar(34, 4104, 4107, 4106.5);
    for (let i = 35; i < 40; i++) bars[i] = bar(i, 4106, 4109, 4108);
    bars[37] = bar(37, 4105.3, 4108, 4107);
    expect(findMsnrFlip("BUY", [swingHigh], bars, atr)).toBeNull();
  });
  it("close kembali di bawah level → flip gagal", () => {
    const bars = base();
    bars[34] = bar(34, 4104, 4107, 4106.5);
    for (let i = 35; i < 40; i++) bars[i] = bar(i, 4106, 4109, 4108);
    bars[38] = bar(38, 4106, 4107, 4104.5);
    expect(findMsnrFlip("BUY", [swingHigh], bars, atr)).toBeNull();
  });
  it("tembus < 0,1 ATR → belum dianggap break", () => {
    const bars = base();
    bars[34] = bar(34, 4104, 4105.3, 4105.1);
    expect(findMsnrFlip("BUY", [swingHigh], bars, atr)).toBeNull();
  });
  it("SELL: cermin di swing low", () => {
    const bars = base();
    bars[34] = bar(34, 4096, 4100, 4097.5);
    for (let i = 35; i < 40; i++) bars[i] = bar(i, 4094, 4098, 4095);
    expect(findMsnrFlip("SELL", [swingLow], bars, atr)).toEqual({ level: swingLow, breakIndex: 34 });
  });
  it("detectAll (msnr_flip) di data demo: hanya searah bias H1, SL/TP rencana TF", () => {
    const cfg = mergeConfig({ strategies: ["msnr_flip"] });
    let found = 0;
    for (let t = Date.parse("2026-07-14T06:00:00Z") / 1000; t < Date.parse("2026-07-16T06:00:00Z") / 1000; t += 1800) {
      const raw = demoView(t);
      const closed: Partial<Record<Timeframe, Candle[]>> = {};
      for (const tf of Object.keys(raw) as Timeframe[]) closed[tf] = closedAsOf(raw[tf] ?? [], tf, t);
      const analysis = analyzeMarket({ nowSec: t, candles: closed }, analysisTfs(cfg), cfg.biasTfs);
      for (const c of detectAll({ analysis, candles: closed, price: demoPrice(t / 60), spreadPips: 3, nowSec: t, dataTime: t, config: cfg })) {
        expect(c.strategy).toBe("msnr_flip");
        expect(analysis.tfs.H1?.bias).toBe(c.direction === "BUY" ? "bullish" : "bearish");
        expect(c.reasons.some((r) => r.includes("searah tren H1"))).toBe(true);
        expect(c.slPips).toBe(cfg.planByTf[c.timeframe]!.slPips);
        found++;
      }
    }
    expect(found).toBeGreaterThan(0);
  }, 60000);
});
