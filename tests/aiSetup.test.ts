import { describe, expect, it } from "vitest";
import { aiOutcome, aiPendingStatus, buildAiContext, buildAiPrompt, parseAiJson, validateAiSetup, type AiContext, type AiRaw } from "../src/core/aiSetup.ts";
import { DEFAULT_XAUUSD } from "../src/core/instrument.ts";
import { closedAsOf } from "../src/core/dataQuality.ts";
import type { Candle, Timeframe } from "../src/core/types.ts";
import { demoView } from "./helpers.ts";

// harga 4000, ATR M15 (risiko) 4 USD, ATR TF gambar 5 USD; resistance 4030, support 3980
const ctx: AiContext = {
  tf: "M15",
  price: 4000,
  priceTimeSec: 1_000_000,
  atr: { M15: 5, H1: 9 },
  atrRisk: 4,
  levels: [
    { price: 4030, touches: 3, kind: "resistance", tf: "H1" },
    { price: 3980, touches: 2, kind: "support", tf: "M15" },
  ],
  rangeHigh: 4045,
  rangeLow: 3960,
  bias: { M15: "bullish", H1: "bullish" },
  structure: { M15: "HH+HL", H1: "HH+HL" },
  bars: { M15: "", H1: "" },
};
const buy = (s: Partial<NonNullable<AiRaw["setup"]>>): AiRaw => ({ image_check: { is_chart: true }, setup: { direction: "BUY", entry_type: "limit", entry: 3998, sl: 3993, tp: 4023, reasons: ["pullback ke demand"], ...s } });

describe("Analisa AI gambar: parser jawaban model", () => {
  it("menerima JSON dalam ```json``` dengan teks di sekitarnya, angka string, arah huruf kecil", () => {
    const r = parseAiJson('Berikut hasilnya:\n```json\n{"bias":"bullish","setup":{"direction":"buy","entry_type":"Limit","entry":"3,998.5","sl":3993,"tp":4023,"reasons":["a",1]}}\n```');
    expect(r?.setup).toMatchObject({ direction: "BUY", entry_type: "limit", entry: 3998.5, sl: 3993, tp: 4023, reasons: ["a"] });
  });
  it("setup null dan teks rusak", () => {
    expect(parseAiJson('{"bias":"ranging","setup":null}')?.setup).toBeNull();
    expect(parseAiJson("maaf, tidak bisa")).toBeNull();
    expect(parseAiJson("{bukan json}")).toBeNull();
  });
});

describe("Analisa AI gambar: validasi deterministik", () => {
  it("RR 1:5 di level angka AI diterima apa adanya", () => {
    const v = validateAiSetup(buy({}), ctx, DEFAULT_XAUUSD);
    expect(v.ok && v.setup).toMatchObject({ direction: "BUY", entryType: "limit", entry: 3998, sl: 3993, tp: 4023, rr: 5, slPips: 50, tpPips: 250 });
  });
  it("RR 1:7 dipertahankan bila TP di level struktur (resistance H1 4030)", () => {
    const v = validateAiSetup(buy({ tp: 4029 }), ctx, DEFAULT_XAUUSD);
    expect(v.ok && v.setup.rr).toBeCloseTo(6.2, 1);
    expect(v.notes.join(" ")).toMatch(/level struktur \(resistance H1 4030/);
  });
  it("RR 1:3 tanpa level → TP digeser ke 1:5; RR 1:10 → 1:6", () => {
    const a = validateAiSetup(buy({ tp: 4013 }), ctx, DEFAULT_XAUUSD);
    expect(a.ok && a.setup).toMatchObject({ tp: 4023, rr: 5 });
    expect(a.notes[0]).toMatch(/digeser/);
    const b = validateAiSetup(buy({ tp: 4048 }), ctx, DEFAULT_XAUUSD);
    expect(b.ok && b.setup).toMatchObject({ tp: 4028, rr: 6 });
  });
  it("market memakai harga sekarang; limit yang sudah terlewati menjadi market", () => {
    const m = validateAiSetup(buy({ entry_type: "market", entry: 3990, sl: 3995, tp: 4025 }), ctx, DEFAULT_XAUUSD);
    expect(m.ok && m.setup).toMatchObject({ entryType: "market", entry: 4000, rr: 5 });
    const l = validateAiSetup(buy({ entry: 4002, sl: 3997, tp: 4027 }), ctx, DEFAULT_XAUUSD);
    expect(l.ok && l.setup.entryType).toBe("market");
  });
  it("menolak: urutan salah, SL terlalu dekat/jauh, entry terlalu jauh, bukan chart, tanpa setup", () => {
    const reason = (r: AiRaw) => {
      const v = validateAiSetup(r, ctx, DEFAULT_XAUUSD);
      return v.ok ? "ok" : `${v.status}: ${v.reason}`;
    };
    expect(reason(buy({ sl: 4005 }))).toMatch(/^rejected: Urutan harga salah/);
    expect(reason(buy({ sl: 3997 }))).toMatch(/SL terlalu dekat/);
    expect(reason(buy({ sl: 3980, tp: 4100 }))).toMatch(/SL terlalu jauh/);
    expect(reason(buy({ entry: 3990, sl: 3985, tp: 4015 }))).toMatch(/terlalu jauh dari harga sekarang/);
    expect(reason({ image_check: { is_chart: false }, setup: null })).toMatch(/bukan|tidak terbaca sebagai chart/);
    expect(reason({ bias: "ranging", setup: null })).toMatch(/^no_setup/);
  });
});

describe("Analisa AI gambar: order tertunda & hasil satu TP", () => {
  const bar = (time: number, h: number, l: number): Candle => ({ time, open: (h + l) / 2, high: h, low: l, close: (h + l) / 2 });
  const base = { direction: "BUY" as const, entry: 3998, sl: 3993, tp: 4023, createdSec: 1000, expiresSec: 1000 + 12 * 900, barSec: 300 };
  it("limit tersentuh / TP lebih dulu / kedaluwarsa", () => {
    expect(aiPendingStatus({ ...base, candles: [bar(900, 4001, 3999), bar(1200, 4000, 3997.5)], nowSec: 1500 })).toEqual({ status: "entry_touched", touchedSec: 1200 });
    expect(aiPendingStatus({ ...base, candles: [bar(1200, 4024, 3999)], nowSec: 1500 })).toMatchObject({ status: "invalid" });
    expect(aiPendingStatus({ ...base, candles: [bar(1200, 4003, 3999)], nowSec: base.expiresSec + 1 })).toMatchObject({ status: "expired" });
    expect(aiPendingStatus({ ...base, candles: [bar(1200, 4003, 3999)], nowSec: 1500 })).toEqual({ status: "pending" });
  });
  it("WIN di TP = +RR (tanpa BE/TP bertahap), LOSS = −1R", () => {
    const o = { direction: "BUY" as const, entry: 3998, sl: 3993, tp: 4023, entryTouchedAtSec: 1200, barSec: 300, price: null, nowSec: 5000, spec: DEFAULT_XAUUSD };
    // naik ke +10 (TP1 lama) lalu turun ke entry: tanpa BE sinyal tetap berjalan
    expect(aiOutcome({ ...o, candles: [bar(1500, 4008, 3999), bar(1800, 4003, 3997)] })).toMatchObject({ outcome: "open" });
    expect(aiOutcome({ ...o, candles: [bar(1500, 4008, 3999), bar(1800, 4024, 4000)] })).toMatchObject({ outcome: "win", pips: 250, r: 5 });
    expect(aiOutcome({ ...o, candles: [bar(1500, 4008, 3999), bar(1800, 4001, 3992)] })).toMatchObject({ outcome: "loss", pips: -50, r: -1 });
  });
});

describe("Analisa AI gambar: konteks & prompt dari data demo", () => {
  it("konteks berisi ATR, level, bar; prompt memuat aturan RR & harga sekarang", () => {
    const t = Date.parse("2026-07-01T12:00:00Z") / 1000;
    const raw = demoView(t);
    const closed: Partial<Record<Timeframe, Candle[]>> = {};
    for (const tf of Object.keys(raw) as Timeframe[]) closed[tf] = closedAsOf(raw[tf] ?? [], tf, t);
    const price = closed.M15!.at(-1)!.close;
    const c = buildAiContext({ tf: "M15", price, priceTimeSec: t, candles: closed });
    expect(c).not.toBeNull();
    expect(c!.atr.M15).toBeGreaterThan(0);
    expect(c!.bars.M15!.split("\n")).toHaveLength(60);
    expect(c!.bars.H1!.split("\n")).toHaveLength(40);
    const p = buildAiPrompt(c!, "fokus sesi London");
    expect(p).toContain(`Harga sekarang ${c!.price.toFixed(2)}`);
    expect(p).toContain("1:5 sampai 1:6");
    expect(p).toContain("Catatan pengguna: fokus sesi London");
  });
});
