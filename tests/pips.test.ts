import { describe, expect, it } from "vitest";
import { DEFAULT_PIP_PLAN, DEFAULT_XAUUSD, levelsFromEntry, pipsToPrice, priceToPips, roundToTick } from "../src/core/instrument.ts";

describe("definisi pip XAUUSD default", () => {
  it("1 pip = 0.10; 50/100/150 pips = 5/10/15", () => {
    expect(pipsToPrice(1, DEFAULT_XAUUSD)).toBe(0.1);
    expect(pipsToPrice(50, DEFAULT_XAUUSD)).toBe(5);
    expect(pipsToPrice(100, DEFAULT_XAUUSD)).toBe(10);
    expect(pipsToPrice(150, DEFAULT_XAUUSD)).toBe(15);
    expect(priceToPips(5, DEFAULT_XAUUSD)).toBe(50);
  });

  it("BUY dari 3000.00 → SL 2995, TP1 3005, TP2 3010, TP3 3015", () => {
    const l = levelsFromEntry("BUY", 3000, DEFAULT_PIP_PLAN, DEFAULT_XAUUSD);
    expect(l).toEqual({ entry: 3000, sl: 2995, tp1: 3005, tp2: 3010, tp3: 3015 });
  });

  it("SELL dari 3000.00 → arah sebaliknya", () => {
    const l = levelsFromEntry("SELL", 3000, DEFAULT_PIP_PLAN, DEFAULT_XAUUSD);
    expect(l).toEqual({ entry: 3000, sl: 3005, tp1: 2995, tp2: 2990, tp3: 2985 });
  });

  it("pip size broker lain (0.01) menghasilkan level berbeda — tidak diasumsikan sama", () => {
    const spec = { ...DEFAULT_XAUUSD, pipSize: 0.01 };
    const l = levelsFromEntry("BUY", 3000, DEFAULT_PIP_PLAN, spec);
    expect(l.sl).toBe(2999.5);
    expect(l.tp3).toBe(3001.5);
  });

  it("pembulatan ke tick tanpa galat floating point", () => {
    expect(roundToTick(2412.3449999, DEFAULT_XAUUSD)).toBe(2412.34);
    expect(levelsFromEntry("BUY", 2412.37, DEFAULT_PIP_PLAN, DEFAULT_XAUUSD).tp1).toBe(2417.37);
  });
});
