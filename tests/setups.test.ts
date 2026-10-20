import { describe, expect, it } from "vitest";
import { evaluateStatus, type StoredSetup } from "../src/core/setups.ts";
import type { Candle } from "../src/core/types.ts";

const base: StoredSetup = {
  id: "s1", identity_key: "k", strategy: "trend_pullback", direction: "BUY", timeframe: "M15", confirm_tf: "M5",
  entry_type: "limit", entry_price: 3000, entry_low: 2998, entry_high: 3000, invalidation: 2996, sl: 2995,
  created_at_sec: 1_000_200, expires_at_sec: 1_014_600, status: "approaching", eligible: true,
  confirmed_at_sec: null, entry_touched_at_sec: null,
};
const c = (time: number, o: number, h: number, l: number, cl: number): Candle => ({ time, open: o, high: h, low: l, close: cl });

describe("lifecycle peluang", () => {
  it("limit BUY tersentuh saat harga turun ke entry; bar pembuatan diabaikan", () => {
    const candles = [c(1_000_200, 3002, 3003, 2999, 3002), c(1_000_500, 3002, 3003, 3001, 3002)];
    const u1 = evaluateStatus(base, { nowSec: 1_000_700, price: 3002, confirmCandles: candles, mainBias: "bullish", dataOk: true });
    expect(u1.status).toBe("approaching");
    const u2 = evaluateStatus(base, { nowSec: 1_000_700, price: 2999.9, confirmCandles: candles, mainBias: "bullish", dataOk: true });
    expect(u2.status).toBe("entry_touched");
  });

  it("data tidak valid → sentuhan entry tidak dicatat", () => {
    const u = evaluateStatus(base, { nowSec: 1_000_700, price: 2999, confirmCandles: [], mainBias: "bullish", dataOk: false });
    expect(u.status).not.toBe("entry_touched");
  });

  it("close candle tertutup melewati invalidasi → invalid", () => {
    const candles = [c(1_000_500, 3002, 3002, 2994, 2995)];
    const u = evaluateStatus(base, { nowSec: 1_000_900, price: 2995, confirmCandles: candles, mainBias: "bullish", dataOk: true });
    expect(u.status).toBe("invalid");
  });

  it("kedaluwarsa setelah expires_at", () => {
    const u = evaluateStatus(base, { nowSec: 1_014_700, price: 3004, confirmCandles: [], mainBias: "bullish", dataOk: true });
    expect(u.status).toBe("expired");
  });

  it("bias utama berbalik → invalid", () => {
    const u = evaluateStatus(base, { nowSec: 1_000_700, price: 3004, confirmCandles: [], mainBias: "bearish", dataOk: true });
    expect(u.status).toBe("invalid");
  });

  it("MSNR flip melawan bias utama tidak dibatalkan bias; tetap bisa kena entry, invalidasi struktur tetap berlaku", () => {
    const m: StoredSetup = { ...base, strategy: "msnr_flip" };
    expect(evaluateStatus(m, { nowSec: 1_000_700, price: 3004, confirmCandles: [], mainBias: "bearish", dataOk: true }).status).toBe("approaching");
    expect(evaluateStatus(m, { nowSec: 1_000_700, price: 2999.9, confirmCandles: [], mainBias: "bearish", dataOk: true }).status).toBe("entry_touched");
    const broke = [c(1_000_500, 3002, 3002, 2994, 2995)];
    expect(evaluateStatus(m, { nowSec: 1_000_900, price: 2995, confirmCandles: broke, mainBias: "bearish", dataOk: true }).status).toBe("invalid");
  });

  it("waktu sentuhan = awal candle M5 pertama yang menyentuh, bukan waktu deteksi", () => {
    const m5 = [c(1_000_200, 3002, 3003, 2999, 3002), c(1_000_500, 3002, 3003, 3001, 3002), c(1_000_800, 3002, 3002, 2999.5, 3001)];
    const u = evaluateStatus(base, { nowSec: 1_001_700, price: 3002, confirmCandles: [], touchCandles: m5, mainBias: "bullish", dataOk: true });
    // candle 1_000_200 (saat setup dibuat) diabaikan walau low-nya menyentuh entry
    expect(u).toMatchObject({ status: "entry_touched", entryTouchedAt: 1_000_800 });
  });

  it("sentuhan hanya lewat tick harga → waktu deteksi", () => {
    const m5 = [c(1_000_500, 3002, 3003, 3001, 3002)];
    const u = evaluateStatus(base, { nowSec: 1_000_700, price: 2999.9, confirmCandles: [], touchCandles: m5, mainBias: "bullish", dataOk: true });
    expect(u).toMatchObject({ status: "entry_touched", entryTouchedAt: 1_000_700 });
  });

  it("stop SELL tersentuh saat harga turun ke entry", () => {
    const s: StoredSetup = { ...base, direction: "SELL", entry_type: "stop", entry_price: 2990, entry_low: 2990, entry_high: 2993, invalidation: 2997, sl: 2995 };
    const u = evaluateStatus(s, { nowSec: 1_000_700, price: 2989.5, confirmCandles: [], mainBias: "bearish", dataOk: true });
    expect(u.status).toBe("entry_touched");
  });
});
