import { describe, expect, it } from "vitest";
import { parseGoldApi, parseTwelveDataQuote, parseTwelveDataSeries, spotHybrid } from "../src/core/providers.ts";

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
