import { describe, expect, it } from "vitest";
import { evaluateOutcome, gradeOf } from "../src/core/outcome.ts";
import { DEFAULT_XAUUSD } from "../src/core/instrument.ts";

const bar = (time: number, h: number, l: number) => ({ time, open: (h + l) / 2, high: h, low: l, close: (h + l) / 2 });
const base = { direction: "BUY" as const, entry: 3000, sl: 2995, tps: [3005, 3010, 3015] as [number, number, number], entryTouchedAtSec: 1000, barSec: 300, price: null, nowSec: 5000, maxHoldSec: 86400, spec: DEFAULT_XAUUSD };

describe("hasil sinyal menurut feed", () => {
  it("SL sebelum TP1 → LOSS −50 pips", () => {
    const r = evaluateOutcome({ ...base, candles: [bar(900, 3001, 2999), bar(1200, 3002, 2994)] });
    expect(r).toMatchObject({ outcome: "loss", pips: -50, tpHit: 0 });
  });
  it("TP2 lalu SL → WIN +100 pips (TP tertinggi sebelum SL)", () => {
    const r = evaluateOutcome({ ...base, candles: [bar(1200, 3006, 3000), bar(1500, 3011, 3004), bar(1800, 3008, 2994)] });
    expect(r).toMatchObject({ outcome: "win", pips: 100, tpHit: 2 });
  });
  it("TP3 → WIN +150 pips", () => {
    expect(evaluateOutcome({ ...base, candles: [bar(1200, 3016, 2999)] })).toMatchObject({ outcome: "win", pips: 150, tpHit: 3 });
  });
  it("SL & TP1 di candle yang sama → konservatif LOSS dan ditandai ambigu", () => {
    const r = evaluateOutcome({ ...base, candles: [bar(1200, 3006, 2994)] });
    expect(r).toMatchObject({ outcome: "loss", ambiguous: true });
  });
  it("SELL simetris", () => {
    const r = evaluateOutcome({ ...base, direction: "SELL", sl: 3005, tps: [2995, 2990, 2985], candles: [bar(1200, 3001, 2994)] });
    expect(r).toMatchObject({ outcome: "open", tpHit: 1 });
  });
  it("masih berjalan / batas waktu", () => {
    expect(evaluateOutcome({ ...base, candles: [bar(1200, 3003, 2998)] }).outcome).toBe("open");
    const t = evaluateOutcome({ ...base, candles: [bar(1200, 3003, 2998)], price: 3002, nowSec: 1000 + 86400 });
    expect(t).toMatchObject({ outcome: "timeout", pips: 20 });
  });
  it("TP yang sudah tercatat tidak turun lagi walau harga kembali", () => {
    const r = evaluateOutcome({ ...base, candles: [], price: 3002, tpHitBefore: 1 });
    expect(r).toMatchObject({ outcome: "open", tpHit: 1 });
  });
  it("SL setelah TP1 tercatat → WIN +50 pips", () => {
    const r = evaluateOutcome({ ...base, candles: [bar(1200, 3001, 2994)], tpHitBefore: 1 });
    expect(r).toMatchObject({ outcome: "win", pips: 50, tpHit: 1, ambiguous: false });
  });
  it("grade dari skor", () => {
    expect([gradeOf(85), gradeOf(72), gradeOf(61), gradeOf(40), gradeOf(null)]).toEqual(["A+", "A", "B", "C", null]);
  });
});
