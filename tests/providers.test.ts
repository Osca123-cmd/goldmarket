import { describe, expect, it } from "vitest";
import { createProvider, marketHoursOnly, parseGoldApi, parseTwelveDataQuote, parseTwelveDataSeries, spotHybrid, tdHybrid, usesTwelveDataCandles } from "../src/core/providers.ts";

const WED = Date.parse("2026-10-14T09:00:00Z") / 1000; // pasar buka
const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

function fakeFetch(spot: number | null, paxgMid: number, spotTime = WED) {
  return (url: string) => {
    if (url.includes("gold-api")) return spot == null ? Promise.reject(new Error("down")) : json({ price: spot, updatedAt: new Date(spotTime * 1000).toISOString() });
    if (url.includes("bookTicker")) return json({ bidPrice: String(paxgMid - 0.01), askPrice: String(paxgMid + 0.01) });
    if (url.includes("interval=1d")) return json([[WED * 1000, String(paxgMid - 10), String(paxgMid + 5), String(paxgMid - 12), String(paxgMid), "1"]]);
    return json([[(WED - 300) * 1000, "4160", "4165", "4159", "4164", "1"], [WED * 1000, "4164", "4166", "4163", "4165", "1"]]);
  };
}

describe("provider", () => {
  it("parse gold-api & Twelve Data", () => {
    expect(parseGoldApi({ price: 4166.1, updatedAt: "2026-10-17T15:24:42Z" })).toEqual({ price: 4166.1, time: Date.parse("2026-10-17T15:24:42Z") / 1000 });
    expect(() => parseGoldApi({ price: "x" })).toThrow();
    expect(parseTwelveDataSeries({ values: [{ datetime: "2026-10-14 09:05:00", open: "1", high: "2", low: "0.5", close: "1.5" }] })[0].time).toBe(Date.parse("2026-10-14T09:05:00Z") / 1000);
    expect(parseTwelveDataQuote({ close: "4166.1", timestamp: 100, is_market_open: true }).marketOpen).toBe(true);
  });

  it("spot hybrid: harga = XAU spot, candle digeser basis spot−PAXG", async () => {
    const p = spotHybrid(null, fakeFetch(4166.1, 4164.07) as never);
    const q = await p.fetchQuote(WED);
    expect(q.price).toBe(4166.1);
    expect(p.basis).toBeCloseTo(2.03, 6);
    const c = await p.fetchCandles("M5", 2, WED);
    expect(c[1].close).toBeCloseTo(4165 + 2.03, 6);
  });

  it("td hybrid: harga = XAU spot gold-api, candle = XAU/USD Twelve Data tanpa digeser, tanpa quote Twelve Data", async () => {
    const calls: string[] = [];
    const base = fakeFetch(4166.1, 4164.07);
    const f = (url: string) => {
      calls.push(url);
      if (url.includes("twelvedata")) return json({ values: [{ datetime: "2026-10-14 09:00:00", open: "4165", high: "4167", low: "4164", close: "4166.4" }] });
      return base(url);
    };
    const p = tdHybrid("KEY", null, f as never);
    const q = await p.fetchQuote(WED);
    expect(q.price).toBe(4166.1);
    expect(p.basis).toBeCloseTo(2.03, 6);
    const c = await p.fetchCandles("M15", 12, WED);
    expect(c[0].close).toBe(4166.4);
    expect(calls.filter((u) => u.includes("twelvedata"))).toHaveLength(1);
    expect(calls.some((u) => u.includes("twelvedata.com/quote"))).toBe(false);
    expect(calls.find((u) => u.includes("twelvedata"))).toContain("end_date=2026-10-14%2009%3A00%3A00");
    expect(usesTwelveDataCandles("td_hybrid")).toBe(true);
    expect(usesTwelveDataCandles("spot_hybrid")).toBe(false);
    expect(() => createProvider("td_hybrid", {})).toThrow(/TWELVEDATA_API_KEY/);
    expect(createProvider("td_hybrid", { twelveDataKey: "KEY" }).id).toBe("td_hybrid");
  });

  it("spot hybrid: gold-api gagal → PAXG + basis terakhir dan ditandai", async () => {
    const p = spotHybrid(2, fakeFetch(null, 4164) as never);
    const q = await p.fetchQuote(WED);
    expect(q.price).toBeCloseTo(4166, 6);
    expect(p.lastQuoteNote).toMatch(/gold-api/);
  });

  it("spot hybrid: basis tidak diperbarui saat pasar tutup", async () => {
    const SAT = Date.parse("2026-10-17T15:00:00Z") / 1000;
    const p = spotHybrid(1.5, fakeFetch(4170, 4160, SAT) as never);
    await p.fetchQuote(SAT);
    expect(p.basis).toBe(1.5);
  });
});

describe("provider spot hybrid: inisialisasi", () => {
  it("basis awal dibuat walau pasar tutup bila belum ada", async () => {
    const SAT = Date.parse("2026-10-17T15:00:00Z") / 1000;
    const p = spotHybrid(null, fakeFetch(4166, 4164, SAT) as never);
    await p.fetchQuote(SAT);
    expect(p.basis).toBeCloseTo(2, 6);
  });
});

describe("marketHoursOnly (buang bar PAXG di luar jam pasar emas)", () => {
  const bar = (iso: string) => ({ time: Date.parse(iso) / 1000, open: 1, high: 1, low: 1, close: 1 });
  const keep = (iso: string, tf: "M15" | "H1" | "D1") => marketHoursOnly([bar(iso)], tf).length === 1;
  it("weekend and daily break are dropped; trading hours kept (NY time, EDT)", () => {
    expect(keep("2026-10-16T20:45:00Z", "M15")).toBe(true); // Jumat 16:45 NY
    expect(keep("2026-10-16T21:00:00Z", "M15")).toBe(false); // Jumat 17:00 NY — tutup mingguan
    expect(keep("2026-10-17T12:00:00Z", "M15")).toBe(false); // Sabtu
    expect(keep("2026-10-18T21:45:00Z", "M15")).toBe(false); // Minggu sebelum buka
    expect(keep("2026-10-18T22:00:00Z", "M15")).toBe(true); // Minggu 18:00 NY — buka
    expect(keep("2026-10-14T21:15:00Z", "M15")).toBe(false); // Rabu jeda harian 17:15 NY
    expect(keep("2026-10-14T22:00:00Z", "M15")).toBe(true); // Rabu 18:00 NY
    expect(keep("2026-10-14T21:00:00Z", "H1")).toBe(false); // H1 17:00–18:00 NY seluruhnya jeda
    expect(keep("2026-10-14T20:00:00Z", "H1")).toBe(true);
  });
  it("daily bars: Saturday dropped, Friday and Sunday (opens 18:00 NY) kept", () => {
    expect(keep("2026-10-17T00:00:00Z", "D1")).toBe(false);
    expect(keep("2026-10-16T00:00:00Z", "D1")).toBe(true);
    expect(keep("2026-10-18T00:00:00Z", "D1")).toBe(true);
  });
});
