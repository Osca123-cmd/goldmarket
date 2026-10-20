import { describe, expect, it } from "vitest";
import { detectAll, findOrderBlock } from "../src/core/strategies.ts";
import { analyzeMarket } from "../src/core/analysis.ts";
import { closedAsOf } from "../src/core/dataQuality.ts";
import { analysisTfs, mergeConfig } from "../src/core/config.ts";
import { demoPrice } from "../src/core/providers.ts";
import type { Swing } from "../src/core/structure.ts";
import type { Candle, Timeframe } from "../src/core/types.ts";
import { demoView } from "./helpers.ts";

const atr = 2;
const bar = (i: number, open: number, high: number, low: number, close: number): Candle => ({ time: i * 900, open, high, low, close });
// 30 bar datar 4100–4102, swing high 4103 di index 20; candle turun (OB) index 24, BOS naik index 26
const up = () => {
  const bars = Array.from({ length: 30 }, (_, i) => bar(i, 4101, 4102, 4100, 4101));
  bars[20] = bar(20, 4101, 4103, 4100.5, 4102);
  bars[24] = bar(24, 4101.5, 4101.8, 4099.5, 4100);
  bars[25] = bar(25, 4100.2, 4102.9, 4100, 4102.8);
  bars[26] = bar(26, 4102.8, 4106, 4102.6, 4105.5);
  for (let i = 27; i < 30; i++) bars[i] = bar(i, 4105.5, 4107, 4104.5, 4106);
  return bars;
};
const swH: Swing = { index: 20, time: 20 * 900, price: 4103, kind: "high" };

describe("Order Block: candle berlawanan terakhir sebelum dorongan yang menembus struktur", () => {
  it("BUY: zona = low OB … puncak badan OB, BOS terdeteksi", () => {
    expect(findOrderBlock("BUY", up(), [swH], atr)).toEqual({ zoneLow: 4099.5, zoneHigh: 4101.5, obIndex: 24, bosIndex: 26, level: 4103 });
  });
  it("zona sudah di-retest setelah BOS → bukan OB segar", () => {
    const bars = up();
    bars[28] = bar(28, 4105, 4105.5, 4101.2, 4104);
    expect(findOrderBlock("BUY", bars, [swH], atr)).toBeNull();
  });
  it("tembusan < 0,1 ATR → bukan BOS", () => {
    const bars = up();
    bars[26] = bar(26, 4102.8, 4103.2, 4102.6, 4103.1);
    for (let i = 27; i < 30; i++) bars[i] = bar(i, 4103, 4103.1, 4102.7, 4103);
    expect(findOrderBlock("BUY", bars, [swH], atr)).toBeNull();
  });
  it("zona lebih dari 1,5 ATR → ditolak", () => {
    const bars = up();
    bars[24] = bar(24, 4101.5, 4101.8, 4097, 4100);
    expect(findOrderBlock("BUY", bars, [swH], atr)).toBeNull();
  });
  it("detectAll (order_block) di data demo: tidak pernah melawan bias utama, SL/TP rencana TF", () => {
    const cfg = mergeConfig({ strategies: ["order_block"] });
    let found = 0;
    for (let t = Date.parse("2026-07-01T00:00:00Z") / 1000; t < Date.parse("2026-07-15T00:00:00Z") / 1000; t += 1800) {
      const raw = demoView(t);
      const closed: Partial<Record<Timeframe, Candle[]>> = {};
      for (const tf of Object.keys(raw) as Timeframe[]) closed[tf] = closedAsOf(raw[tf] ?? [], tf, t);
      const analysis = analyzeMarket({ nowSec: t, candles: closed }, analysisTfs(cfg), cfg.biasTfs);
      for (const c of detectAll({ analysis, candles: closed, price: demoPrice(t / 60), spreadPips: 3, nowSec: t, dataTime: t, config: cfg })) {
        expect(c.strategy).toBe("order_block");
        expect(analysis.mainBias).not.toBe(c.direction === "BUY" ? "bearish" : "bullish");
        expect(c.slPips).toBe(cfg.planByTf[c.timeframe]!.slPips);
        // entry limit Order Block tetap di tepi dekat zona (BUY: atas, SELL: bawah)
        if (c.entryType === "limit") expect(c.entry).toBeCloseTo(c.direction === "BUY" ? c.entryHigh : c.entryLow, 1);
        found++;
      }
    }
    expect(found).toBeGreaterThan(0);
  }, 180000);
});
