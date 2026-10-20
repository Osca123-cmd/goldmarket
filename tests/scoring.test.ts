import { describe, expect, it } from "vitest";
import { scoreSetup, type ScoreInput } from "../src/core/scoring.ts";
import type { MarketBias } from "../src/core/types.ts";

const base: ScoreInput = { direction: "BUY", mainBias: "bullish", strongBias: false, levelTouches: 2, hasStructuralInvalidation: true, roomToTp1: true, confirmed: true, rsi: 55, rsiPrev: 52, slAtrContext: 1.2, spreadPips: 3, slPips: 50 };
const trend = (i: ScoreInput) => scoreSetup(i).components.find((c) => c.key === "trend")!;

describe("bonus skor TF info (H4)", () => {
  it("H4 searah menambah 5 poin tren, maks 25", () => {
    expect(trend({ ...base, infoBias: "bullish", infoTf: "H4" }).points).toBe(23);
    expect(trend({ ...base, strongBias: true, infoBias: "bullish", infoTf: "H4" }).points).toBe(25);
    expect(trend({ ...base, mainBias: "bearish", infoBias: "bullish", infoTf: "H4" }).points).toBe(5);
    expect(trend({ ...base, infoBias: "bullish", infoTf: "H4" }).note).toContain("H4 juga searah");
  });
  it("H4 tidak pernah menurunkan skor (jumlah sinyal tidak berkurang)", () => {
    for (const mainBias of ["bullish", "bearish", "ranging"] as MarketBias[])
      for (const strongBias of [true, false])
        for (const infoBias of ["bullish", "bearish", "ranging", undefined] as (MarketBias | undefined)[]) {
          const i = { ...base, mainBias, strongBias };
          expect(scoreSetup({ ...i, infoBias, infoTf: "H4" }).total).toBeGreaterThanOrEqual(scoreSetup(i).total);
        }
  });
});
