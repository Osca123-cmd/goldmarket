import { describe, expect, it } from "vitest";
import { DEFAULT_BT, runBacktest, simulate, wilson } from "../src/core/backtest.ts";
import { DEFAULT_XAUUSD } from "../src/core/instrument.ts";
import { DEFAULT_ENGINE_CONFIG } from "../src/core/config.ts";
import type { SetupCandidate } from "../src/core/strategies.ts";
import { demoSeries } from "./helpers.ts";

const setup = { direction: "BUY", entryType: "limit", entry: 3000, sl: 2995, tp1: 3005, tp2: 3010, tp3: 3015, invalidation: 2996, expiresAt: 10_000, createdAt: 0 } as unknown as SetupCandidate;
const bar = (time: number, h: number, l: number, c = (h + l) / 2) => ({ time, open: c, high: h, low: l, close: c });
const o = { ...DEFAULT_BT, spreadPips: 0, slippagePips: 0 };

describe("simulasi backtest", () => {
  it("SL dan TP dalam candle yang sama → ambigu, dihitung konservatif sebagai SL", () => {
    const r = simulate(setup, [bar(300, 3001, 2999.5, 3000), bar(600, 3006, 2994)], DEFAULT_XAUUSD, o);
    expect(r.entryTouched).toBe(true);
    expect(r.ambiguous).toBe(true);
    expect(r.tp[0]).toBe(false);
  });

  it("TP1 sebelum SL", () => {
    const r = simulate(setup, [bar(300, 3001, 2999.5, 3000), bar(600, 3006, 2999), bar(900, 3001, 2994)], DEFAULT_XAUUSD, o);
    expect(r.tp).toEqual([true, false, false]);
  });

  it("biaya membuat TP harus bergerak lebih jauh", () => {
    const r = simulate(setup, [bar(300, 3001, 2999.5, 3000), bar(600, 3005.1, 2999)], DEFAULT_XAUUSD, { ...o, spreadPips: 4 });
    expect(r.tp[0]).toBe(null); // 3005.1 < 3005 + 0.2 biaya
  });

  it("entry tidak tersentuh sebelum kedaluwarsa", () => {
    const r = simulate(setup, [bar(300, 3010, 3001), bar(20_000, 3001, 2990)], DEFAULT_XAUUSD, o);
    expect(r.entryTouched).toBe(false);
  });

  it("interval Wilson", () => {
    const w = wilson(30, 60);
    expect(w.p).toBe(0.5);
    expect(w.lo!).toBeCloseTo(0.375, 2);
    expect(w.hi!).toBeCloseTo(0.625, 2);
    expect(wilson(0, 0).p).toBeNull();
  });

  it("walk-forward memisahkan data pengembangan dan pengujian", () => {
    const end = Date.parse("2026-07-24T20:00:00Z") / 1000;
    const candles = { H4: demoSeries("H4", end, 400), H1: demoSeries("H1", end, 600), M15: demoSeries("M15", end, 700), M5: demoSeries("M5", end, 2200) };
    const rep = runBacktest(candles, { ...DEFAULT_ENGINE_CONFIG, pairs: [{ context: "M15", confirm: "M5" }] }, { ...DEFAULT_BT, window: 220 });
    const all = rep.find((r) => r.key === "all");
    expect(all).toBeDefined();
    expect(all!.dev.setups + all!.test.setups).toBeGreaterThan(0);
    expect(all!.splitAt).toBeGreaterThanOrEqual(all!.periodFrom);
  }, 60_000);
});
