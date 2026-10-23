import { describe, expect, it } from "vitest";
import { findSrTouch } from "../src/core/srTouch.ts";
import { detectAll } from "../src/core/strategies.ts";
import { analyzeMarket, type MultiTfAnalysis } from "../src/core/analysis.ts";
import { closedAsOf } from "../src/core/dataQuality.ts";
import { DEFAULT_ENGINE_CONFIG, analysisTfs, mergeConfig } from "../src/core/config.ts";
import { demoPrice } from "../src/core/providers.ts";
import type { Candle, Timeframe } from "../src/core/types.ts";
import { demoView } from "./helpers.ts";

const c = (i: number, open: number, high: number, low: number, close: number): Candle => ({ time: i * 900, open, high, low, close });
// ATR 2, support 100 (2 sentuhan): zona sentuh ≤ 100,3; close minimal 99,7; 3 bar sebelumnya close > 100,6
const analysis = (touches = 2) => ({ tfs: { M15: { atr: 2, levels: [{ price: 100, touches, lastTime: 0, kind: "support" }] } } }) as unknown as MultiTfAnalysis;
function bars(prevLow = 101, last: [number, number, number, number] = [101.2, 101.4, 100.1, 100.8]): Candle[] {
  const out = Array.from({ length: 30 }, (_, i) => c(i, 105, 105.5, 104.5, 105));
  out.push(c(30, 104, 104.2, 102.8, 103)); // 3 bar sebelum: masih jauh di atas level
  out.push(c(31, 103, 103.2, 101.8, 102));
  out.push(c(32, 102, 102.2, prevLow, 101.2)); // bar sebelumnya
  out.push(c(33, ...last)); // bar sentuh
  return out;
}

describe("S/R Market Entry: sentuhan pertama level", () => {
  it("BUY: sentuhan pertama support dari atas terdeteksi", () => {
    const t = findSrTouch("BUY", "M15", analysis(), { M15: bars() });
    expect(t?.level.price).toBe(100);
    expect(t?.bar.time).toBe(33 * 900);
  });
  it("bukan sentuhan pertama (bar sebelumnya sudah di zona) → tidak ada", () => {
    expect(findSrTouch("BUY", "M15", analysis(), { M15: bars(100.2) })).toBeNull();
  });
  it("close jauh di bawah level (level jebol) → tidak ada", () => {
    expect(findSrTouch("BUY", "M15", analysis(), { M15: bars(101, [101.2, 101.4, 99.4, 99.5]) })).toBeNull();
  });
  it("level dengan 1 sentuhan diabaikan; arah SELL tidak terdeteksi dari pola BUY", () => {
    expect(findSrTouch("BUY", "M15", analysis(1), { M15: bars() })).toBeNull();
    expect(findSrTouch("SELL", "M15", analysis(), { M15: bars() })).toBeNull();
  });
  it("config default: dua arah, tanpa filter momentum, kedaluwarsa 4 bar, label jujur (bukan AI)", () => {
    expect(DEFAULT_ENGINE_CONFIG.direction?.twoWay).toContain("sr_market");
    expect(DEFAULT_ENGINE_CONFIG.direction?.momentum?.skip).toContain("sr_market");
    expect(DEFAULT_ENGINE_CONFIG.expiryBars.sr_market).toBe(4);
  });
  it("detectAll di data demo: setup sr_market selalu entry market di M15 dengan rencana 50 pips", () => {
    const cfg = mergeConfig({ strategies: ["sr_market"], biasTfs: { major: "H1", minor: "M30" }, chopRanging: { bars: 4, maxAtr: 2, tf: "H1" }, engineMinScore: 0 });
    let found = 0;
    for (let t = Date.parse("2026-07-01T00:00:00Z") / 1000; t < Date.parse("2026-07-03T00:00:00Z") / 1000; t += 900) {
      const raw = demoView(t);
      const closed: Partial<Record<Timeframe, Candle[]>> = {};
      for (const tf of Object.keys(raw) as Timeframe[]) closed[tf] = closedAsOf(raw[tf] ?? [], tf, t);
      const an = analyzeMarket({ nowSec: t, candles: closed }, analysisTfs(cfg), cfg.biasTfs);
      const price = closed.M15!.at(-1)!.close;
      for (const x of detectAll({ analysis: an, candles: closed, price, spreadPips: 3, nowSec: t, dataTime: t, config: cfg })) {
        found++;
        expect(x).toMatchObject({ strategy: "sr_market", timeframe: "M15", entryType: "market", slPips: 50 });
        expect(x.reasons.some((r) => r.startsWith("S/R Market Entry"))).toBe(true);
      }
    }
    expect(found).toBeGreaterThan(0);
  }, 300000);
});
