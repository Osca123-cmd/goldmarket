import { describe, expect, it } from "vitest";
import { detectAll, momentumDirection } from "../src/core/strategies.ts";
import { analyzeMarket } from "../src/core/analysis.ts";
import { closedAsOf } from "../src/core/dataQuality.ts";
import { analysisTfs, mergeConfig } from "../src/core/config.ts";
import { demoPrice } from "../src/core/providers.ts";
import { evaluateStatus, type StoredSetup } from "../src/core/setups.ts";
import type { Candle, Timeframe } from "../src/core/types.ts";
import { demoView } from "./helpers.ts";

const bars = (closes: number[]): Candle[] => closes.map((c, i) => ({ time: i * 900, open: c, high: c + 1, low: c - 1, close: c }));

describe("arah dari setup & momentum, bukan dipaksa tren besar", () => {
  it("momentum EMA8/21: harga naik → BUY, turun → SELL, data kurang → null", () => {
    expect(momentumDirection(bars(Array.from({ length: 60 }, (_, i) => 4100 + i)), 8, 21)?.direction).toBe("BUY");
    expect(momentumDirection(bars(Array.from({ length: 60 }, (_, i) => 4160 - i)), 8, 21)?.direction).toBe("SELL");
    expect(momentumDirection(bars([4100, 4101]), 8, 21)).toBeNull();
  });

  it("detectAll (config live) di data demo: arah searah momentum M15 kecuali S&D (skip); melawan bias utama tetap lolos gate struktur", () => {
    const cfg = mergeConfig({ strategies: ["sd_reversal", "crt", "fvg_retest", "order_block"], minSlAtrContext: 0.6, invalidationTolPips: 5 });
    let found = 0;
    for (let t = Date.parse("2026-07-01T00:00:00Z") / 1000; t < Date.parse("2026-07-08T00:00:00Z") / 1000; t += 1800) {
      const raw = demoView(t);
      const closed: Partial<Record<Timeframe, Candle[]>> = {};
      for (const tf of Object.keys(raw) as Timeframe[]) closed[tf] = closedAsOf(raw[tf] ?? [], tf, t);
      const analysis = analyzeMarket({ nowSec: t, candles: closed }, analysisTfs(cfg), cfg.biasTfs);
      const m = momentumDirection(closed.M15 ?? [], 8, 21);
      for (const c of detectAll({ analysis, candles: closed, price: demoPrice(t / 60), spreadPips: 3, nowSec: t, dataTime: t, config: cfg })) {
        if (c.strategy !== "sd_reversal") expect(c.direction).toBe(m!.direction);
        expect(c.reasons.some((r) => r.startsWith("Momentum M15"))).toBe(true);
        if (c.strategy !== "sd_reversal" && analysis.mainBias === (c.direction === "BUY" ? "bearish" : "bullish"))
          expect(c.gates.find((g) => g.key === "structure")?.pass).toBe(true);
        found++;
      }
    }
    expect(found).toBeGreaterThan(0);
  }, 180000);

  it("momentum.skip: strategi pembalikan tidak disaring momentum, strategi lain tetap", () => {
    const run = (skip: string[] | undefined) => {
      const base = mergeConfig({ strategies: ["sd_reversal", "fvg_retest"] });
      const cfg = { ...base, direction: { ...base.direction!, momentum: { tf: "M15" as const, fast: 8, slow: 21, skip: skip as never } } };
      const out: { strategy: string; against: boolean }[] = [];
      for (let t = Date.parse("2026-07-01T00:00:00Z") / 1000; t < Date.parse("2026-07-04T00:00:00Z") / 1000; t += 3600) {
        const raw = demoView(t);
        const closed: Partial<Record<Timeframe, Candle[]>> = {};
        for (const tf of Object.keys(raw) as Timeframe[]) closed[tf] = closedAsOf(raw[tf] ?? [], tf, t);
        const analysis = analyzeMarket({ nowSec: t, candles: closed }, analysisTfs(cfg), cfg.biasTfs);
        const m = momentumDirection(closed.M15 ?? [], 8, 21)!;
        for (const c of detectAll({ analysis, candles: closed, price: demoPrice(t / 60), spreadPips: 3, nowSec: t, dataTime: t, config: cfg }))
          out.push({ strategy: c.strategy, against: c.direction !== m.direction });
      }
      return out;
    };
    expect(run([]).some((x) => x.against)).toBe(false);
    const skipped = run(["sd_reversal"]);
    expect(skipped.filter((x) => x.against).every((x) => x.strategy === "sd_reversal")).toBe(true);
    expect(skipped.some((x) => x.against)).toBe(true);
  }, 180000);

  it("config default: S&D dikecualikan dari momentum; invalidasi per strategi terisi", () => {
    const cfg = mergeConfig({ strategies: ["sd_reversal"] });
    expect(cfg.direction?.momentum?.skip).toEqual(["sd_reversal"]);
    expect(cfg.invalidationAtr).toMatchObject({ breakout_retest: 0.4, trend_pullback: 0.2, sd_reversal: 0.25 });
    // override sebagian lewat engine_state.config tidak menghapus nilai lain
    expect(mergeConfig({ invalidationAtr: { breakout_retest: 0.5 } }).invalidationAtr).toMatchObject({ breakout_retest: 0.5, sd_reversal: 0.25 });
  });

  it("tanpa config.direction (backtest riset): tidak ada filter momentum", () => {
    const cfg = mergeConfig({ strategies: ["fvg_retest"], direction: undefined });
    const t = Date.parse("2026-07-02T12:00:00Z") / 1000;
    const raw = demoView(t);
    const closed: Partial<Record<Timeframe, Candle[]>> = {};
    for (const tf of Object.keys(raw) as Timeframe[]) closed[tf] = closedAsOf(raw[tf] ?? [], tf, t);
    const analysis = analyzeMarket({ nowSec: t, candles: closed }, analysisTfs(cfg), cfg.biasTfs);
    for (const c of detectAll({ analysis, candles: closed, price: demoPrice(t / 60), spreadPips: 3, nowSec: t, dataTime: t, config: cfg }))
      expect(c.reasons.some((r) => r.startsWith("Momentum"))).toBe(false);
  });

  it("CRT/OB dalam twoWay tidak dibatalkan saat bias utama berbalik; tanpa twoWay tetap dibatalkan", () => {
    const s: StoredSetup = {
      id: "s1", identity_key: "k", strategy: "crt", direction: "BUY", timeframe: "M15", confirm_tf: "M5",
      entry_type: "limit", entry_price: 3000, entry_low: 2998, entry_high: 3000, invalidation: 2996, sl: 2995,
      created_at_sec: 1_000_200, expires_at_sec: 1_014_600, status: "approaching", eligible: true,
      confirmed_at_sec: null, entry_touched_at_sec: null,
    };
    const args = { nowSec: 1_000_700, price: 3004, confirmCandles: [], mainBias: "bearish" as const, dataOk: true };
    expect(evaluateStatus(s, { ...args, twoWay: ["crt", "fvg_retest", "order_block"] }).status).toBe("approaching");
    expect(evaluateStatus({ ...s, strategy: "order_block" }, { ...args, twoWay: ["crt", "fvg_retest", "order_block"] }).status).toBe("approaching");
    expect(evaluateStatus(s, args).status).toBe("invalid");
  });
});
