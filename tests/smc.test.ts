import { describe, expect, it } from "vitest";
import { findSmcChoch } from "../src/core/strategies.ts";
import { DEFAULT_ENGINE_CONFIG, RETIRED_STRATEGIES } from "../src/core/config.ts";
import type { Swing } from "../src/core/structure.ts";
import type { Candle } from "../src/core/types.ts";

const c = (i: number, open: number, high: number, low: number, close: number): Candle => ({ time: i * 900, open, high, low, close });

// ATR = 1. Swing high 102 (bar 5), swing low 99 (bar 8); bar 11 menyapu ke 98,5; dorongan bar 13 meninggalkan
// FVG 99,6–100,2 (high bar 12 … low bar 14); bar 14 close 102,2 menembus swing high 102 (CHoCH).
function scenario(lastLow = 101): Candle[] {
  const bars: Candle[] = [];
  for (let i = 0; i <= 10; i++) bars.push(c(i, 100, i === 5 ? 102 : 100.4, i === 8 ? 99 : 99.8, 100));
  bars.push(c(11, 100, 100.2, 98.5, 99));
  bars.push(c(12, 98.8, 99.6, 98.7, 99.5));
  bars.push(c(13, 99.6, 101.5, 99.5, 101.4));
  bars.push(c(14, 101.4, 102.3, 100.2, 102.2));
  bars.push(c(15, 102.2, 102.4, 101.2, 101.9));
  bars.push(c(16, 101.9, 102, lastLow, 101.8));
  return bars;
}
const swings: Swing[] = [
  { index: 5, time: 5 * 900, price: 102, kind: "high" },
  { index: 8, time: 8 * 900, price: 99, kind: "low" },
];

describe("SMC: sapuan likuiditas → CHoCH → FVG", () => {
  it("menemukan sapuan swing low, CHoCH di atas swing high, dan FVG dorongan yang belum diisi", () => {
    const f = findSmcChoch("BUY", scenario(), swings, 1);
    expect(f).not.toBeNull();
    expect(f!.sweep.time).toBe(11 * 900);
    expect(f!.sweepLevel).toBe(99);
    expect(f!.choch.time).toBe(14 * 900);
    expect(f!.chochLevel).toBe(102);
    expect(f!.fvg).toEqual({ low: 99.6, high: 100.2, index: 13 });
  });

  it("FVG yang sudah dimasuki harga tidak dipakai", () => {
    expect(findSmcChoch("BUY", scenario(100.1), swings, 1)).toBeNull();
  });

  it("tanpa sapuan (ujung tidak menembus swing low) tidak ada setup", () => {
    const bars = scenario();
    // ujung terendah 99,0 = tepat di swing low (< 0,1 ATR), bukan sapuan
    bars[11] = c(11, 100, 100.2, 99.05, 99.3);
    bars[12] = c(12, 99.3, 99.6, 99.0, 99.5);
    expect(findSmcChoch("BUY", bars, swings, 1)).toBeNull();
  });

  it("arah berlawanan tidak terdeteksi dari pola BUY", () => {
    expect(findSmcChoch("SELL", scenario(), swings, 1)).toBeNull();
  });

  it("config default: SMC dua arah dengan invalidasi 0,3 ATR; Trend pullback & MSNR flip pensiun", () => {
    expect(DEFAULT_ENGINE_CONFIG.direction?.twoWay).toContain("smc_choch");
    expect(DEFAULT_ENGINE_CONFIG.invalidationAtr?.smc_choch).toBe(0.3);
    expect(DEFAULT_ENGINE_CONFIG.expiryBars.smc_choch).toBe(12);
    expect(RETIRED_STRATEGIES).toEqual(["trend_pullback", "msnr_flip"]);
  });
});
