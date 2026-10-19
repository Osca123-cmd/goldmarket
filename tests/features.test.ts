import { describe, expect, it } from "vitest";
import { setupFeatures } from "../src/core/features.ts";
import { DEFAULT_ENGINE_CONFIG } from "../src/core/config.ts";
import type { DetectContext, SetupCandidate } from "../src/core/strategies.ts";
import type { Candle } from "../src/core/types.ts";

const DAY = Date.parse("2026-10-14T00:00:00Z") / 1000; // Rabu
const NOW = DAY + 10 * 3600; // 10:00 UTC
const bar = (time: number, high: number, low: number): Candle => ({ time, open: (high + low) / 2, high, low, close: (high + low) / 2 });

// H1 kemarin: high 4120, low 4080; hari ini 00–09 di 4100–4110
const h1: Candle[] = [];
for (let h = 0; h < 24; h++) h1.push(bar(DAY - 86400 + h * 3600, h === 15 ? 4120 : 4105, h === 3 ? 4080 : 4095));
for (let h = 0; h < 10; h++) h1.push(bar(DAY + h * 3600, 4110, 4100));
// M15 Asia (00–07 UTC): high 4110, low 4100
const m15: Candle[] = [];
for (let t = DAY; t < NOW - 900; t += 900) m15.push(bar(t, 4110, 4100));

const setup = (direction: "BUY" | "SELL", entry: number) =>
  ({
    direction, entry, sl: direction === "BUY" ? entry - 5 : entry + 5, entryLow: entry - 1, entryHigh: entry + 1, timeframe: "M15", entryType: "limit", confirmed: false,
    score: { total: 70, components: [{ key: "trend", points: 25 }, { key: "structure", points: 15 }, { key: "candle", points: 0 }, { key: "momentum", points: 15 }, { key: "volatilityCost", points: 15 }] },
  }) as unknown as SetupCandidate;

const ctx = (): DetectContext => ({
  analysis: {
    asOf: NOW, mainBias: "bullish", strongBias: true, reasons: [],
    tfs: {
      H1: { bias: "bullish", ema200: 4000, lastClose: 4105, ema50SlopeAtr: 0.8, atr: 10 },
      M30: { bias: "bullish" },
      M15: { bias: "ranging", atr: 5, rsi: 60 },
    },
  } as never,
  candles: { H1: h1, M15: m15 },
  price: 4106,
  spreadPips: 3,
  nowSec: NOW,
  dataTime: NOW,
  config: DEFAULT_ENGINE_CONFIG,
});

describe("setupFeatures", () => {
  it("BUY: searah TF bias besar (H1), ruang ke high kemarin, posisi vs range Asia, angka bulat", () => {
    const f = setupFeatures(setup("BUY", 4104), ctx());
    expect(f.alignH4).toBe(1);
    expect(f.ema200H4).toBe(1);
    expect(f.slopeH4).toBe(0.8);
    expect(f.rsiDir).toBe(60);
    expect(f.roomPrevDayAtr).toBe(1.6); // (4120 − 4104) / 10
    expect(f.backPrevDayAtr).toBe(2.4); // (4104 − 4080) / 10
    expect(f.asiaRel).toBe(0); // di dalam range Asia
    expect(f.round10Pips).toBe(40); // 4104 → 4100
    expect(f.round50Pips).toBe(40); // 4104 → 4100
    expect(f.slAtrCtx).toBe(1);
    expect(f.hourUtc).toBe(10);
    expect(f.dow).toBe(3);
    expect(f.trendPts).toBe(25);
  });

  it("SELL: tanda dinormalkan ke arah setup", () => {
    const f = setupFeatures(setup("SELL", 4095), ctx());
    expect(f.alignH4).toBe(-1);
    expect(f.ema200H4).toBe(-1);
    expect(f.slopeH4).toBe(-0.8);
    expect(f.rsiDir).toBe(40);
    expect(f.roomPrevDayAtr).toBe(1.5); // (4095 − 4080) / 10
    expect(f.asiaRel).toBe(1); // sudah tembus ke bawah range Asia
  });

  it("sebelum 07:00 UTC range Asia belum ada", () => {
    const early = { ...ctx(), nowSec: DAY + 5 * 3600 };
    expect(setupFeatures(setup("BUY", 4104), early).asiaRel).toBeNull();
  });
});
