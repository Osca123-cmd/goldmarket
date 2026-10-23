import { describe, expect, it } from "vitest";
import { evaluateOutcome, gradeOf, mergeFineCandles } from "../src/core/outcome.ts";
import { DEFAULT_XAUUSD } from "../src/core/instrument.ts";

const bar = (time: number, h: number, l: number) => ({ time, open: (h + l) / 2, high: h, low: l, close: (h + l) / 2 });
const base = { direction: "BUY" as const, entry: 3000, sl: 2995, tps: [3005, 3010, 3015] as [number, number, number], entryTouchedAtSec: 1000, barSec: 300, price: null, nowSec: 5000, maxHoldSec: 86400, spec: DEFAULT_XAUUSD };

describe("hasil sinyal menurut feed", () => {
  it("SL sebelum TP1 → LOSS −50 pips", () => {
    const r = evaluateOutcome({ ...base, candles: [bar(900, 3001, 2999), bar(1200, 3002, 2994)] });
    expect(r).toMatchObject({ outcome: "loss", pips: -50, tpHit: 0 });
  });
  it("TP2 lalu kembali ke entry (BE) → WIN +100 pips", () => {
    const r = evaluateOutcome({ ...base, candles: [bar(1200, 3006, 3001), bar(1500, 3011, 3004), bar(1800, 3008, 2994)] });
    expect(r).toMatchObject({ outcome: "win", pips: 100, tpHit: 2 });
  });
  it("TP3 → WIN +150 pips", () => {
    expect(evaluateOutcome({ ...base, candles: [bar(1200, 3016, 3001)] })).toMatchObject({ outcome: "win", pips: 150, tpHit: 3 });
  });
  it("SL & TP1 di candle yang sama → konservatif LOSS dan ditandai ambigu", () => {
    const r = evaluateOutcome({ ...base, candles: [bar(1200, 3006, 2994)] });
    expect(r).toMatchObject({ outcome: "loss", ambiguous: true });
  });
  it("SELL simetris", () => {
    const r = evaluateOutcome({ ...base, direction: "SELL", sl: 3005, tps: [2995, 2990, 2985], candles: [bar(1200, 2999.5, 2994)] });
    expect(r).toMatchObject({ outcome: "open", tpHit: 1 });
  });
  it("masih berjalan / batas waktu", () => {
    expect(evaluateOutcome({ ...base, candles: [bar(1200, 3003, 2998)] }).outcome).toBe("open");
    const t = evaluateOutcome({ ...base, candles: [bar(1200, 3003, 2998)], price: 3002, nowSec: 1000 + 86400 });
    expect(t).toMatchObject({ outcome: "timeout", pips: 20 });
  });
  it("TP yang sudah tercatat tidak turun lagi walau harga kembali", () => {
    const r = evaluateOutcome({ ...base, candles: [], price: 3002, tpHitBefore: 1 });
    expect(r).toMatchObject({ outcome: "open", tpHit: 1 });
  });
  it("TP tercatat tidak mengaktifkan BE sebelum TP benar-benar tersentuh di candle", () => {
    // candle 1200 kembali ke entry sebelum TP1 (candle 1500) → belum BE; BE baru di candle 1800
    const r = evaluateOutcome({ ...base, candles: [bar(1200, 3003, 2999), bar(1500, 3006, 3001), bar(1800, 3002, 2999)], tpHitBefore: 1 });
    expect(r).toMatchObject({ outcome: "win", tpHit: 1, closedAtSec: 1800 });
  });
  it("SL setelah TP1 tercatat → WIN +50 pips", () => {
    // TP1 tercatat dari tick pada 1100 (tidak terlihat di candle) → BE berlaku sejak itu
    const r = evaluateOutcome({ ...base, candles: [bar(1200, 3001, 2994)], tpHitBefore: 1, tpHitBeforeAtSec: 1100 });
    expect(r).toMatchObject({ outcome: "win", pips: 50, tpHit: 1, ambiguous: false });
  });
  it("TP di candle tempat entry tersentuh tidak dihitung; candle berikutnya dihitung", () => {
    // entry tersentuh 1000 di dalam candle 900 yang high-nya sempat di atas TP1 (sebelum turun ke entry)
    expect(evaluateOutcome({ ...base, candles: [bar(900, 3006, 2999)] })).toMatchObject({ outcome: "open", tpHit: 0 });
    expect(evaluateOutcome({ ...base, candles: [bar(900, 3006, 2999), bar(1200, 3006, 3001)] })).toMatchObject({ outcome: "open", tpHit: 1 });
  });
  it("SL di candle sentuhan tetap LOSS", () => {
    expect(evaluateOutcome({ ...base, candles: [bar(900, 3006, 2994)] })).toMatchObject({ outcome: "loss", pips: -50 });
  });
  it("setelah TP1, SL di BE: harga kembali ke entry → WIN +TP1, bukan menunggu SL awal", () => {
    const r = evaluateOutcome({ ...base, candles: [bar(1200, 3006, 3001), bar(1500, 3004, 2999.8)] });
    expect(r).toMatchObject({ outcome: "win", tpHit: 1, pips: 50 });
    expect(r.note).toContain("BE");
  });
  it("TP1 dan entry dalam candle yang sama → ditutup di BE (konservatif)", () => {
    expect(evaluateOutcome({ ...base, candles: [bar(1200, 3006, 2999)] })).toMatchObject({ outcome: "win", tpHit: 1, pips: 50, ambiguous: true });
  });
  it("TP2 dan entry dalam candle yang sama → hanya TP1 dihitung", () => {
    expect(evaluateOutcome({ ...base, candles: [bar(1200, 3011, 2999)] })).toMatchObject({ outcome: "win", tpHit: 1, pips: 50, ambiguous: true });
  });
  it("setelah TP2, SL di TP1: harga kembali ke TP1 → WIN +TP2, tidak menunggu entry", () => {
    // TP1 di 1200, TP2 di 1500, lalu turun ke 3004 (di bawah TP1 3005, masih di atas entry)
    const r = evaluateOutcome({ ...base, candles: [bar(1200, 3006, 3001), bar(1500, 3011, 3006), bar(1800, 3008, 3004)] });
    expect(r).toMatchObject({ outcome: "win", tpHit: 2, pips: 100, closedAtSec: 1800 });
    expect(r.note).toContain("TP1");
    // belum kembali ke TP1 → masih berjalan dengan SL di TP1
    expect(evaluateOutcome({ ...base, candles: [bar(1200, 3006, 3001), bar(1500, 3011, 3006), bar(1800, 3008, 3006)] })).toMatchObject({ outcome: "open", tpHit: 2 });
  });
  it("sinyal live 21 Okt (chop_breakout BUY M30): TP2 tercatat 11.44, candle 12.25 turun ke bawah TP1 → WIN TP2", () => {
    const t = (hhmm: string) => Date.parse(`2026-10-21T${hhmm}:00Z`) / 1000;
    const r = evaluateOutcome({
      ...base,
      entry: 4125.92,
      sl: 4118.92,
      tps: [4132.92, 4139.92, 4146.92],
      entryTouchedAtSec: t("10:50"),
      // candle 11.40 menyentuh TP2 tetapi low-nya juga di bawah TP1 (urutan tidak diketahui) → belum ditutup di candle itu
      candles: [bar(t("11:35"), 4133.72, 4131.16), bar(t("11:40"), 4141.13, 4131.79), bar(t("12:20"), 4138.05, 4133.74), bar(t("12:25"), 4135.26, 4130.87)],
      nowSec: t("12:30"),
      tpHitBefore: 2,
      tpHitBeforeAtSec: t("11:44") + 2,
    });
    expect(r).toMatchObject({ outcome: "win", tpHit: 2, pips: 140, closedAtSec: t("12:25") });
  });
  it("TP3 sebelum BE → WIN +150 (bonus)", () => {
    expect(evaluateOutcome({ ...base, candles: [bar(1200, 3006, 3001), bar(1500, 3016, 3002)] })).toMatchObject({ outcome: "win", tpHit: 3, pips: 150 });
  });
  it("grade dari skor", () => {
    expect([gradeOf(85), gradeOf(72), gradeOf(61), gradeOf(40), gradeOf(null)]).toEqual(["A+", "A", "B", "C", null]);
  });
});

describe("pelacakan dengan candle M1 (23 Okt 2026)", () => {
  const t = (hhmm: string) => Date.parse(`2026-10-23T${hhmm}:00Z`) / 1000;
  // sinyal live S/R Market Entry SELL M15 23 Okt 20.15 WIB: entry market 4032, SL 4037, TP 4027/4022/4017
  const sell = { ...base, direction: "SELL" as const, entry: 4032, sl: 4037, tps: [4027, 4022, 4017] as [number, number, number], entryTouchedAtSec: t("13:15") + 1, nowSec: t("13:31") };
  const m5 = [bar(t("13:15"), 4032.26, 4030.15), bar(t("13:20"), 4032.58, 4030.31), bar(t("13:25"), 4034.68, 4026.09)];
  // isi candle 13.25 per menit: naik dulu ke 4034,68 (belum SL 4037), baru turun menyentuh TP1 4027 di 13.28
  const m1 = [bar(t("13:25"), 4034.68, 4030.7), bar(t("13:26"), 4033.9, 4031.2), bar(t("13:27"), 4031.5, 4028.4), bar(t("13:28"), 4028.6, 4026.09), bar(t("13:29"), 4029.1, 4027.6)];

  it("hanya M5: candle 13.25 menyentuh TP1 dan entry sekaligus → ditutup konservatif TP1 lalu BE (perilaku lama)", () => {
    expect(evaluateOutcome({ ...sell, candles: m5 })).toMatchObject({ outcome: "win", tpHit: 1, pips: 50, ambiguous: true });
  });

  it("dengan M1: urutan diketahui (naik dulu, lalu TP1 di 13.28) → TP1 tercatat, sinyal tetap berjalan dengan SL di BE", () => {
    const r = evaluateOutcome({ ...sell, candles: mergeFineCandles(m5, 300, m1, 60) });
    expect(r).toMatchObject({ outcome: "open", tpHit: 1, tpAtSec: t("13:28"), ambiguous: false });
  });

  it("M1 mendeteksi TP lebih cepat: candle M5 yang masih berjalan diganti M1 yang sudah ada", () => {
    // M5 13.25 belum masuk sama sekali; M1 13.25–13.28 sudah ada
    const r = evaluateOutcome({ ...sell, candles: mergeFineCandles(m5.slice(0, 2), 300, m1.slice(0, 4), 60) });
    expect(r).toMatchObject({ outcome: "open", tpHit: 1, tpAtSec: t("13:28") });
  });

  it("mergeFineCandles: M5 penuh diganti M1, M5 tanpa M1 dipakai apa adanya, span per bar", () => {
    const merged = mergeFineCandles(m5, 300, m1, 60);
    expect(merged.map((c) => [c.time - t("13:15"), c.span])).toEqual([[0, 300], [300, 300], [600, 60], [660, 60], [720, 60], [780, 60], [840, 60]]);
    // M1 bolong di tengah candle lama → candle M5 tetap dipakai
    const holed = mergeFineCandles(m5, 300, [m1[0], m1[1], m1[3], m1[4]], 60);
    expect(holed.filter((c) => c.span === 300)).toHaveLength(3);
  });
});

