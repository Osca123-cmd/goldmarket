import { describe, expect, it } from "vitest";
import { chopRangingContext, isBoxed, type DetectContext } from "../src/core/strategies.ts";
import { mergeConfig } from "../src/core/config.ts";
import { evaluateStatus, type StoredSetup } from "../src/core/setups.ts";
import type { Candle } from "../src/core/types.ts";

const h1 = (i: number, high: number, low: number): Candle => ({ time: i * 3600, open: (high + low) / 2, high, low, close: (high + low) / 2 });
const rule = { bars: 4, maxAtr: 2 };

describe("kandang babi: harga H1 terkurung di kotak sempit", () => {
  it("4 candle H1 terakhir dalam ≤ 2 ATR → kotak", () => {
    const bars = [h1(0, 4150, 4130), h1(1, 4125, 4115), h1(2, 4127, 4112), h1(3, 4126, 4113), h1(4, 4126, 4114)];
    expect(isBoxed(bars, 12, rule)).toEqual({ high: 4127, low: 4112 });
  });
  it("range lebih dari 2 ATR atau candle kurang → bukan kotak", () => {
    expect(isBoxed([h1(0, 4150, 4130), h1(1, 4140, 4120), h1(2, 4130, 4115), h1(3, 4125, 4110)], 12, rule)).toBeNull();
    expect(isBoxed([h1(0, 4126, 4114), h1(1, 4126, 4114)], 12, rule)).toBeNull();
  });

  const ctx = (bias: "bearish" | "ranging", bars: Candle[], withRule = true): DetectContext => ({
    analysis: { asOf: 0, mainBias: bias, strongBias: true, reasons: ["Bias utama bearish: H1 dan M30 searah."], tfs: { H4: { bias, atr: 30 }, H1: { bias, atr: 12 } } } as never,
    candles: { H1: bars },
    price: 4120,
    spreadPips: 3,
    nowSec: 0,
    dataTime: 0,
    config: withRule ? mergeConfig({}) : mergeConfig({ chopRanging: undefined }),
  });
  const boxed = [h1(0, 4127, 4112), h1(1, 4126, 4113), h1(2, 4126, 4114), h1(3, 4125, 4115)];

  it("H4 turun tetapi 4 candle H1 terkurung → konteks S&D memperlakukan H4 (TF bias besar) & bias utama ranging, dengan alasan", () => {
    const x = chopRangingContext(ctx("bearish", boxed))!;
    expect(x.analysis.tfs.H4?.bias).toBe("ranging");
    expect(x.analysis.mainBias).toBe("ranging");
    expect(x.analysis.reasons.at(-1)).toMatch(/kandang babi/);
  });
  it("H1 sudah ranging, tidak terkurung, atau aturan nonaktif → tidak diubah", () => {
    expect(chopRangingContext(ctx("ranging", boxed))).toBeNull();
    expect(chopRangingContext(ctx("bearish", [h1(0, 4160, 4140), h1(1, 4145, 4125), h1(2, 4130, 4112), h1(3, 4120, 4100)]))).toBeNull();
    expect(chopRangingContext(ctx("bearish", boxed, false))).toBeNull();
  });

  it("setup S&D BUY tidak dibatalkan hanya karena bias utama bearish (invalidasi tetap berlaku)", () => {
    const s: StoredSetup = {
      id: "s1", identity_key: "k", strategy: "sd_reversal", direction: "BUY", timeframe: "M15", confirm_tf: "M5",
      entry_type: "limit", entry_price: 3000, entry_low: 2998, entry_high: 3000, invalidation: 2996, sl: 2995,
      created_at_sec: 1_000_200, expires_at_sec: 1_014_600, status: "approaching", eligible: true,
      confirmed_at_sec: null, entry_touched_at_sec: null,
    };
    expect(evaluateStatus(s, { nowSec: 1_000_700, price: 3004, confirmCandles: [], mainBias: "bearish", dataOk: true }).status).toBe("approaching");
    const broke = [{ time: 1_000_500, open: 3002, high: 3002, low: 2994, close: 2995 }];
    expect(evaluateStatus(s, { nowSec: 1_000_900, price: 2995, confirmCandles: broke, mainBias: "bearish", dataOk: true }).status).toBe("invalid");
  });
});

describe("susunan timeframe live (21 Okt 2026)", () => {
  it("bias H4 + M30, setup M15 & M30 dengan konfirmasi M15, kotak kandang babi di H1, tanpa TF info", async () => {
    const { analysisTfs, DEFAULT_ENGINE_CONFIG: d } = await import("../src/core/config.ts");
    expect(d.biasTfs).toEqual({ major: "H4", minor: "M30" });
    expect(d.pairs).toEqual([{ context: "M15", confirm: "M15" }, { context: "M30", confirm: "M15" }]);
    expect(d.infoTf).toBeUndefined();
    expect(d.chopRanging?.tf).toBe("H1");
    expect(analysisTfs(d).sort()).toEqual(["H1", "H4", "M15", "M30"]);
  });
});
