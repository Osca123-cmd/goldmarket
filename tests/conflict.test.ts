import { describe, expect, it } from "vitest";
import { conflictText, findConflicts, type ConflictView } from "../src/core/conflict.ts";

const sig = (o: Partial<ConflictView>): ConflictView => ({
  id: "x", direction: "BUY", timeframe: "M30", entry_price: 4172.15, sl: 4165.15, status: "entry_touched", eligible: true, outcome: "open", ...o,
});

describe("sinyal bertentangan", () => {
  const buyM30 = sig({ id: "buy" });
  const sellM15 = sig({ id: "sell", direction: "SELL", timeframe: "M15", entry_price: 4172.87, sl: 4177.87 });

  it("BUY M30 4172,15 vs SELL M15 4172,87 (19 Okt) → bertentangan dua arah", () => {
    expect(findConflicts(sellM15, [buyM30, sellM15])).toEqual([buyM30]);
    expect(findConflicts(buyM30, [buyM30, sellM15])).toEqual([sellM15]);
    expect(conflictText(buyM30)).toBe("BUY M30 4172.15 (entry tersentuh)");
  });
  it("jual di atas / beli di bawah range (91 pips) → tidak", () => {
    const sell = sig({ id: "s", direction: "SELL", timeframe: "M15", entry_price: 4183.12, sl: 4188.12 });
    const buy = sig({ id: "b", timeframe: "M15", entry_price: 4174.03, sl: 4169.03 });
    expect(findConflicts(sell, [buy])).toEqual([]);
  });
  it("arah sama → tidak", () => {
    expect(findConflicts(buyM30, [sig({ id: "b2", entry_price: 4171 })])).toEqual([]);
  });
  it("lawan sudah selesai, invalid, kedaluwarsa, atau tidak layak → tidak", () => {
    for (const o of [{ outcome: "win" }, { status: "invalid", outcome: null }, { status: "expired", outcome: null }, { status: "approaching", outcome: null, eligible: false }]) {
      expect(findConflicts(buyM30, [{ ...sellM15, ...o }])).toEqual([]);
    }
  });
  it("lawan sudah TP1 tapi posisi masih terbuka, atau masih menunggu entry → tetap bertentangan", () => {
    expect(findConflicts(buyM30, [sellM15])).toHaveLength(1);
    expect(findConflicts(buyM30, [{ ...sellM15, status: "approaching", outcome: null }])).toHaveLength(1);
  });
});
