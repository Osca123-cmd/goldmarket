import { describe, expect, it } from "vitest";
import { CHUNK_SEC, DEFAULT_BT, chunkStartOf, nextChunk, pickVariant, runBacktest, simulate, summarizeTrades, variantStats, wilson, type BacktestTrade } from "../src/core/backtest.ts";
import { DEFAULT_XAUUSD } from "../src/core/instrument.ts";
import { DEFAULT_ENGINE_CONFIG } from "../src/core/config.ts";
import type { SetupCandidate } from "../src/core/strategies.ts";
import { demoSeries } from "./helpers.ts";

const setup = { direction: "BUY", entryType: "limit", entry: 3000, sl: 2995, tp1: 3005, tp2: 3010, tp3: 3015, invalidation: 2996, expiresAt: 10_000, createdAt: 0, slPips: 50, strategy: "trend_pullback", timeframe: "M15" } as unknown as SetupCandidate;
const bar = (time: number, h: number, l: number, c = (h + l) / 2) => ({ time, open: c, high: h, low: l, close: c });
const o = { ...DEFAULT_BT, spreadPips: 0, slippagePips: 0 };

describe("simulasi backtest", () => {
  it("SL dan TP dalam candle yang sama → ambigu, dihitung konservatif sebagai SL", () => {
    const r = simulate(setup, [bar(300, 3001, 2999.5, 3000), bar(600, 3006, 2994)], DEFAULT_XAUUSD, o);
    expect(r.entryTouched).toBe(true);
    expect(r.ambiguous).toBe(true);
    expect(r.tp[0]).toBe(false);
  });

  it("TP1 sebelum SL", () => {
    const r = simulate(setup, [bar(300, 3001, 2999.5, 3000), bar(600, 3006, 2999), bar(900, 3001, 2994)], DEFAULT_XAUUSD, o);
    expect(r.tp).toEqual([true, false, false]);
  });

  it("biaya membuat TP harus bergerak lebih jauh", () => {
    const r = simulate(setup, [bar(300, 3001, 2999.5, 3000), bar(600, 3005.1, 2999)], DEFAULT_XAUUSD, { ...o, spreadPips: 4 });
    expect(r.tp[0]).toBe(null); // 3005.1 < 3005 + 0.2 biaya
  });

  it("entry tidak tersentuh sebelum kedaluwarsa", () => {
    const r = simulate(setup, [bar(300, 3010, 3001), bar(20_000, 3001, 2990)], DEFAULT_XAUUSD, o);
    expect(r.entryTouched).toBe(false);
  });

  it("interval Wilson", () => {
    const w = wilson(30, 60);
    expect(w.p).toBe(0.5);
    expect(w.lo!).toBeCloseTo(0.375, 2);
    expect(w.hi!).toBeCloseTo(0.625, 2);
    expect(wilson(0, 0).p).toBeNull();
  });

  it("walk-forward memisahkan data pengembangan dan pengujian", () => {
    const end = Date.parse("2026-07-24T20:00:00Z") / 1000;
    const candles = { H4: demoSeries("H4", end, 400), H1: demoSeries("H1", end, 600), M15: demoSeries("M15", end, 700), M5: demoSeries("M5", end, 2200) };
    const rep = runBacktest(candles, { ...DEFAULT_ENGINE_CONFIG, pairs: [{ context: "M15", confirm: "M5" }] }, { ...DEFAULT_BT, window: 220 });
    const all = rep.find((r) => r.key === "all");
    expect(all).toBeDefined();
    expect(all!.dev.setups + all!.test.setups).toBeGreaterThan(0);
    expect(all!.splitAt).toBeGreaterThanOrEqual(all!.periodFrom);
  }, 60_000);
});

describe("manajemen posisi A/B/C", () => {
  const fillBar = bar(300, 3001, 2999.5, 3000);
  it("TP1 lalu kembali ke entry, lalu SL: A +50, B −16,7 (2/3 kena SL), C +16,7 (sisa keluar di BE)", () => {
    const r = simulate(setup, [fillBar, bar(600, 3006, 3002, 3004), bar(900, 3003, 2999.9, 3000.5), bar(1200, 3000, 2994, 2995)], DEFAULT_XAUUSD, o);
    expect(r.pips).toEqual({ A: 50, B: -16.7, C: 16.7, D: 20, E: 30, F: 15 });
  });

  it("semua TP tercapai: A +50, B = C = +100", () => {
    const r = simulate(setup, [fillBar, bar(600, 3006, 3001), bar(900, 3011, 3004), bar(1200, 3016, 3009)], DEFAULT_XAUUSD, o);
    expect(r.tp).toEqual([true, true, true]);
    expect(r.pips).toEqual({ A: 50, B: 100, C: 100, D: 20, E: 30, F: 65 });
  });

  it("SL dan TP1 di candle yang sama → konservatif SL untuk semua varian", () => {
    const r = simulate(setup, [fillBar, bar(600, 3006, 2994)], DEFAULT_XAUUSD, o);
    expect(r.ambiguous).toBe(true);
    expect(r.pips).toEqual({ A: -50, B: -50, C: -50, D: -50, E: -50, F: -50 });
  });

  it("biaya: fill lebih buruk → rugi SL = jarak SL + biaya; TP tetap jarak penuh", () => {
    const costs = { ...o, spreadPips: 4 }; // biaya 2 pips
    const loss = simulate(setup, [fillBar, bar(600, 3001, 2994)], DEFAULT_XAUUSD, costs);
    expect(loss.pips?.A).toBe(-52);
    const win = simulate(setup, [fillBar, bar(600, 3005.3, 3001), bar(900, 3010.3, 3004), bar(1200, 3015.3, 3009)], DEFAULT_XAUUSD, costs);
    expect(win.pips).toMatchObject({ A: 50, B: 100, C: 100 });
  });

  it("batas tahan 24 jam: posisi ditutup di close terakhir; TP yang belum kena = gagal", () => {
    const flat = [fillBar];
    for (let t = 600; t <= 300 + 25 * 3600; t += 300) flat.push(bar(t, 3001, 2999.6, 3000.5));
    const r = simulate(setup, flat, DEFAULT_XAUUSD, o);
    expect(r.tp).toEqual([false, false, false]);
    expect(r.pips).toEqual({ A: 5, B: 5, C: 5, D: 5, E: 5, F: 5 });
  });

  it("data habis sebelum tuntas → tidak dihitung (pips null)", () => {
    const r = simulate(setup, [fillBar, bar(600, 3006, 3001)], DEFAULT_XAUUSD, o);
    expect(r.tp[0]).toBe(true);
    expect(r.pips).toBeNull();
  });
});

describe("ringkasan ekspektasi & penjadwalan potongan", () => {
  const tr = (i: number, a: number, extra: Partial<BacktestTrade> = {}): BacktestTrade => ({
    createdAt: i * 3600, strategy: "trend_pullback", timeframe: "M15", direction: "BUY", session: "london", slPips: 50,
    entryTouched: true, invalidBeforeEntry: false, tp: [a > 0, false, false], ambiguous: false, pips: { A: a, B: a, C: a, D: a, E: a, F: a }, ...extra,
  });
  it("ekspektasi, winrate, profit factor, max drawdown", () => {
    const v = variantStats([tr(1, 50), tr(2, -50), tr(3, -50), tr(4, 50), tr(5, 50)], "A");
    expect(v.n).toBe(5);
    expect(v.expPips).toBe(10);
    expect(v.expR).toBe(0.2);
    expect(v.winRate.p).toBe(0.6);
    expect(v.profitFactor).toBe(1.5);
    expect(v.maxDrawdownPips).toBe(100);
    expect(v.totalPips).toBe(50);
  });
  it("entry tak tersentuh / belum tuntas tidak masuk ekspektasi; grup per strategi/sesi/arah; split dev/test", () => {
    const trades = [...Array.from({ length: 10 }, (_, i) => tr(i, i % 2 ? 50 : -50)), tr(20, 0, { entryTouched: false, pips: null }), tr(21, 0, { pips: null })];
    const rep = summarizeTrades(trades)!;
    const all = rep.test.find((g) => g.key === "all")!;
    expect(rep.dev.find((g) => g.key === "all")!.setups + all.setups).toBe(12);
    expect(all.variants.A.n).toBeLessThan(all.setups);
    expect(rep.test.map((g) => g.key)).toEqual(expect.arrayContaining(["strategy:trend_pullback|M15", "session:london", "direction:BUY"]));
  });
  it("nextChunk: terbaru dulu, lalu mundur; potongan final dilewati; potongan berjalan diperbarui setelah 6 jam", () => {
    const now = Date.parse("2026-10-17T22:00:00Z") / 1000;
    const cur = chunkStartOf(now);
    expect(new Date(cur * 1000).getUTCDay()).toBe(1); // Senin
    expect(nextChunk([], now)).toBe(cur);
    const doneCur = { start: cur, computedAt: now - 3600 };
    expect(nextChunk([doneCur], now)).toBe(cur - CHUNK_SEC);
    expect(nextChunk([{ start: cur, computedAt: now - 7 * 3600 }], now)).toBe(cur);
    const all = [];
    for (let st = cur; st >= cur - 60 * CHUNK_SEC; st -= CHUNK_SEC) all.push({ start: st, computedAt: st === cur ? now : st + CHUNK_SEC + 2 * 86400 });
    expect(nextChunk(all, now, 12)).toBeNull();
  });
});

describe("pemilihan varian (dev memilih, uji membuktikan)", () => {
  // D: win rate tinggi & positif; A: ekspektasi tinggi tapi win rate rendah
  const mk = (i: number, win: boolean, dev: boolean): BacktestTrade => ({
    createdAt: (dev ? 0 : 1_000_000) + i * 3600, strategy: "trend_pullback", timeframe: "M15", direction: "BUY", session: "london", slPips: 50,
    entryTouched: true, invalidBeforeEntry: false, tp: [false, false, false], ambiguous: false,
    pips: { A: win && i % 2 === 0 ? 150 : -53, B: -10, C: -5, D: win ? 20 : -53, E: win ? 30 : -53, F: -1 },
  });
  const trades = [...Array.from({ length: 60 }, (_, i) => mk(i, i % 10 !== 0, true)), ...Array.from({ length: 40 }, (_, i) => mk(i, i % 10 !== 0, false))];
  it("memilih varian ber-WR ≥ 75% dengan ekspektasi tertinggi di data pengembangan, lalu menilai di data uji", () => {
    const pick = pickVariant(summarizeTrades(trades)!, 0.75)!;
    expect(pick.meetsTarget).toBe(true);
    expect(pick.variant).toBe("E"); // WR 90%, E = 0,9·30 − 0,1·53 > D
    expect(pick.dev.winRate.p).toBeGreaterThanOrEqual(0.75);
    expect(pick.verdict).toBe("terbukti");
  });
  it("tanpa varian yang memenuhi target → ekspektasi tertinggi, meetsTarget = false", () => {
    const pick = pickVariant(summarizeTrades(trades)!, 0.95)!;
    expect(pick.meetsTarget).toBe(false);
  });
});
