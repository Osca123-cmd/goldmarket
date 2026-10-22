import { describe, expect, it } from "vitest";
import { detectAll, hmdPattern, zigzag } from "../src/core/strategies.ts";
import { runEngineCycle } from "../src/core/engine.ts";
import { analyzeMarket } from "../src/core/analysis.ts";
import { closedAsOf } from "../src/core/dataQuality.ts";
import { DEFAULT_ENGINE_CONFIG, analysisTfs, mergeConfig, pairsFor, satelliteTfs } from "../src/core/config.ts";
import { demoPrice } from "../src/core/providers.ts";
import type { Candle, Timeframe } from "../src/core/types.ts";
import { demoView } from "./helpers.ts";

const bar = (i: number, close: number, open = close): Candle => ({ time: i * 300, open, high: Math.max(open, close) + 0.5, low: Math.min(open, close) - 0.5, close });

describe("SIGNAL-HMD: zigzag + pola konfirmasi indikator pengguna", () => {
  it("zigzag: kaki naik → +1 (Sell-point di puncak); kaki turun → -1 (Buy-point di low terendah, tetap saat memantul)", () => {
    const up = Array.from({ length: 60 }, (_, i) => bar(i, 100 + i));
    expect(zigzag(up, 30, 0.05, 5)).toEqual({ direction: 1, pivotIndex: 59 });
    const down = [...up, ...Array.from({ length: 20 }, (_, i) => bar(60 + i, 158 - i))];
    expect(zigzag(down, 30, 0.05, 5)).toEqual({ direction: -1, pivotIndex: 79 });
    const bounce = [...down, ...Array.from({ length: 3 }, (_, i) => bar(80 + i, 140 + i))];
    expect(zigzag(bounce, 30, 0.05, 5)).toEqual({ direction: -1, pivotIndex: 79 });
  });

  it("pola konfirmasi mode longgar: engulfing & hammer dikenali, candle biasa tidak", () => {
    const base = Array.from({ length: 20 }, (_, i) => bar(i, 100, 100.4));
    const engulf = [...base, { time: 6000, open: 100.5, high: 100.6, low: 99.4, close: 99.5 }, { time: 6300, open: 99.4, high: 101, low: 99.3, close: 100.8 }];
    expect(hmdPattern("BUY", engulf, engulf.length - 1)).toBe("Bullish engulfing");
    expect(hmdPattern("SELL", engulf, engulf.length - 1)).toBeNull();
    const hammer = [...base, { time: 6000, open: 100, high: 100.25, low: 98.5, close: 100.2 }];
    expect(hmdPattern("BUY", hammer, hammer.length - 1)).toBe("Hammer");
    // candle turun kecil tanpa ekor bawah panjang: bukan pola BUY apa pun
    const plain = [...base, { time: 6000, open: 100.3, high: 100.4, low: 100.0, close: 100.1 }];
    expect(hmdPattern("BUY", plain, plain.length - 1)).toBeNull();
  });

  it("config default: SIGNAL-HMD hanya di pasangan M5/M5, tanpa filter momentum; M5 = TF satelit di luar gate global", () => {
    const cfg = mergeConfig({ strategies: ["sd_reversal", "signal_hmd"] });
    expect(pairsFor(cfg, "signal_hmd")).toEqual([{ context: "M5", confirm: "M5" }]);
    expect(pairsFor(cfg, "sd_reversal")).toEqual(cfg.pairs);
    expect(cfg.direction?.momentum?.skip).toContain("signal_hmd");
    expect(cfg.direction?.twoWay).toContain("signal_hmd");
    expect(analysisTfs(cfg)).toContain("M5");
    expect(satelliteTfs(cfg)).toEqual(["M5"]);
    // strategi tidak aktif → M5 tidak dianalisis
    const off = mergeConfig({ strategies: ["sd_reversal"] });
    expect(analysisTfs(off)).not.toContain("M5");
    expect(satelliteTfs(off)).toEqual([]);
    expect(DEFAULT_ENGINE_CONFIG.minScoreByTf.M5).toBe(60);
  });

  it("detectAll di data demo: setup SIGNAL-HMD hanya M5 dengan rencana 50 pips; strategi lain tidak pernah di M5", () => {
    const cfg = mergeConfig({ strategies: ["breakout_retest", "signal_hmd"], biasTfs: { major: "H1", minor: "M30" }, chopRanging: { bars: 4, maxAtr: 2, tf: "H1" } });
    let hmd = 0;
    for (let t = Date.parse("2026-07-01T00:00:00Z") / 1000; t < Date.parse("2026-07-03T00:00:00Z") / 1000; t += 1800) {
      const raw = demoView(t);
      const closed: Partial<Record<Timeframe, Candle[]>> = {};
      for (const tf of Object.keys(raw) as Timeframe[]) closed[tf] = closedAsOf(raw[tf] ?? [], tf, t);
      const analysis = analyzeMarket({ nowSec: t, candles: closed }, analysisTfs(cfg), cfg.biasTfs);
      for (const c of detectAll({ analysis, candles: closed, price: demoPrice(t / 60), spreadPips: 3, nowSec: t, dataTime: t, config: { ...cfg, engineMinScore: 0 } })) {
        if (c.strategy === "signal_hmd") {
          hmd++;
          expect(c.timeframe).toBe("M5");
          expect(c.slPips).toBe(50);
          expect(c.reasons.some((r) => r.startsWith("SIGNAL-HMD"))).toBe(true);
        } else expect(c.timeframe).not.toBe("M5");
      }
    }
    expect(hmd).toBeGreaterThan(0);
  }, 180000);

  it("candle M5 telat hanya menahan setup M5; gate kualitas global (M15/M30/H1/H4) tetap lolos", () => {
    const t = Date.parse("2026-07-14T10:00:00Z") / 1000;
    const raw = demoView(t);
    raw.M5 = raw.M5!.slice(0, -12); // M5 tertinggal ±1 jam
    const cfg = { ...mergeConfig({ strategies: ["breakout_retest", "signal_hmd"] }), biasTfs: { major: "H1", minor: "M30" } as const };
    const out = runEngineCycle({ nowSec: t, rawCandles: raw, price: demoPrice(t / 60), quoteTimeSec: t, spreadPips: 3, assumedSpreadPips: 3, feedStatus: "live", previousFeedStatus: "live", existing: [], config: cfg });
    expect(out.quality.ok).toBe(true);
    expect(out.created.every((c) => c.timeframe !== "M5")).toBe(true);
  }, 60000);
});
