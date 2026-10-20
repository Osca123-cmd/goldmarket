import { describe, expect, it } from "vitest";
import { detectChopBreakout, type DetectContext } from "../src/core/strategies.ts";
import { analyzeMarket } from "../src/core/analysis.ts";
import { mergeConfig } from "../src/core/config.ts";
import type { Candle, Timeframe } from "../src/core/types.ts";

// harga datar 4100,5–4102,5 (ATR ≈ 2) di semua TF → 4 candle H1 terakhir terkurung (kotak 4100,5–4102,5)
const flat = (n: number, step: number): Candle[] =>
  Array.from({ length: n }, (_, i) => ({ time: i * step, open: i % 2 ? 4101 : 4102, high: 4102.5, low: 4100.5, close: i % 2 ? 4102 : 4101 }));

function ctx(lastM15: Partial<Candle>, prevClose = 4101.5): DetectContext {
  const m15 = flat(120, 900);
  m15[m15.length - 2] = { ...m15[m15.length - 2], close: prevClose };
  m15[m15.length - 1] = { ...m15[m15.length - 1], ...lastM15 };
  const candles: Partial<Record<Timeframe, Candle[]>> = { H1: flat(120, 3600), M30: flat(120, 1800), M15: m15 };
  const config = mergeConfig({ strategies: ["chop_breakout"], direction: undefined });
  const analysis = analyzeMarket({ nowSec: 120 * 3600, candles }, ["H1", "M30", "M15"], config.biasTfs);
  return { analysis, candles, price: m15[m15.length - 1].close, spreadPips: 3, nowSec: 120 * 3600, dataTime: 120 * 3600, config };
}
const pairM30 = { context: "M30" as const, confirm: "M15" as const };
const breakout = { open: 4102, high: 4104.2, low: 4101.9, close: 4104 };

describe("breakout kandang babi", () => {
  it("close M15 pertama di atas kotak dengan badan kuat → BUY limit retest di tepi kotak, rencana M30", () => {
    const c = detectChopBreakout("BUY", pairM30, ctx(breakout))!;
    expect(c).not.toBeNull();
    expect(c.strategy).toBe("chop_breakout");
    expect(c.timeframe).toBe("M30");
    expect(c.entryType).toBe("limit");
    expect(c.entry).toBeCloseTo(4102.5, 1);
    expect(c.invalidation).toBeLessThan(4102.5);
    expect(c.reasons.some((r) => r.startsWith("Breakout kandang babi"))).toBe(true);
  });
  it("tidak ada arah SELL saat tembusan ke atas", () => {
    expect(detectChopBreakout("SELL", pairM30, ctx(breakout))).toBeNull();
  });
  it("bukan close pertama di luar kotak (candle sebelumnya sudah di luar) → tidak ada setup", () => {
    expect(detectChopBreakout("BUY", pairM30, ctx(breakout, 4103))).toBeNull();
  });
  it("badan candle tembusan lemah (< 0,5 ATR M15) → tidak ada setup", () => {
    expect(detectChopBreakout("BUY", pairM30, ctx({ open: 4103.6, high: 4104.2, low: 4103.4, close: 4104 }))).toBeNull();
  });
  it("hanya pasangan konteks M30", () => {
    expect(detectChopBreakout("BUY", { context: "M15", confirm: "M15" }, ctx(breakout))).toBeNull();
  });
});
