import { describe, expect, it } from "vitest";
import { detectAll, findCrtSweep } from "../src/core/strategies.ts";
import { analyzeMarket } from "../src/core/analysis.ts";
import { closedAsOf } from "../src/core/dataQuality.ts";
import { DEFAULT_ENGINE_CONFIG, analysisTfs, mergeConfig } from "../src/core/config.ts";
import { demoPrice } from "../src/core/providers.ts";
import type { Candle, Timeframe } from "../src/core/types.ts";
import { demoView } from "./helpers.ts";

const bar = (time: number, open: number, high: number, low: number, close: number): Candle => ({ time, open, high, low, close });
// range H1 07:00–08:00: 4170–4180
const R = bar(25200, 4175, 4180, 4170, 4176);
const atr = 3;

describe("CRT: sapuan ujung range H1 lalu kembali ke dalam", () => {
  it("BUY: candle sesudah range menembus low ≥ 0,1 ATR lalu close di dalam", () => {
    const sweep = bar(28800 + 900, 4171, 4172, 4168.5, 4171.5);
    expect(findCrtSweep("BUY", R, [bar(28800, 4176, 4177, 4171, 4171.2), sweep], atr)).toEqual(sweep);
  });
  it("close di luar range → bukan CRT", () => {
    expect(findCrtSweep("BUY", R, [bar(28800, 4171, 4172, 4168, 4169)], atr)).toBeNull();
  });
  it("candle sesudahnya kembali close di luar → batal", () => {
    expect(findCrtSweep("BUY", R, [bar(28800, 4171, 4172, 4168, 4171), bar(29700, 4171, 4171.5, 4167, 4168)], atr)).toBeNull();
  });
  it("sapuan terlalu kecil (< 0,1 ATR) → bukan CRT", () => {
    expect(findCrtSweep("BUY", R, [bar(28800, 4171, 4172, 4169.8, 4171)], atr)).toBeNull();
  });
  it("candle sebelum range H1 tertutup diabaikan", () => {
    expect(findCrtSweep("BUY", R, [bar(27900, 4171, 4172, 4168, 4171)], atr)).toBeNull();
  });
  it("SELL: cermin di sisi high", () => {
    const sweep = bar(28800, 4179, 4182, 4178, 4179.5);
    expect(findCrtSweep("SELL", R, [sweep], atr)).toEqual(sweep);
  });
  it("detectAll dengan crt aktif berjalan di data demo; setup crt memakai rencana SL/TP TF", () => {
    // tanpa filter arah momentum (diuji di direction.test.ts) agar detektor CRT sendiri teruji
    const cfg = mergeConfig({ strategies: ["crt"], direction: undefined });
    let found = 0;
    for (let t = Date.parse("2026-07-14T06:00:00Z") / 1000; t < Date.parse("2026-07-16T06:00:00Z") / 1000; t += 1800) {
      const raw = demoView(t);
      const closed: Partial<Record<Timeframe, Candle[]>> = {};
      for (const tf of Object.keys(raw) as Timeframe[]) closed[tf] = closedAsOf(raw[tf] ?? [], tf, t);
      const analysis = analyzeMarket({ nowSec: t, candles: closed }, analysisTfs(cfg), cfg.biasTfs);
      for (const c of detectAll({ analysis, candles: closed, price: demoPrice(t / 60), spreadPips: 3, nowSec: t, dataTime: t, config: cfg })) {
        expect(c.strategy).toBe("crt");
        expect(c.slPips).toBe(cfg.planByTf[c.timeframe]?.slPips ?? DEFAULT_ENGINE_CONFIG.plan.slPips);
        found++;
      }
    }
    expect(found).toBeGreaterThan(0);
  }, 60000);
});
