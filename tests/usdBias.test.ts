import { describe, expect, it } from "vitest";
import { aggregateCandles, usdBias, usdNewsTone, usdPriceTrend, xauTrendSupport } from "../src/core/usdBias.ts";
import { eventBias } from "../src/core/eventBias.ts";
import type { Candle } from "../src/core/types.ts";

// EUR/USD M15 menurun bertahap dengan ayunan (swing) → struktur LH/LL, di bawah EMA → bearish → USD menguat
function eurusd(n: number, slope: number): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const mid = 1.1 + slope * i + 0.0012 * Math.sin(i / 3);
    return { time: 1_790_000_100 - (1_790_000_100 % 900) + i * 900, open: mid, high: mid + 0.0004, low: mid - 0.0004, close: mid + (slope > 0 ? 0.0001 : -0.0001) };
  });
}

describe("arah USD hari ini", () => {
  it("M15 → H1 digabung per jam (open pertama, high/low ekstrem, close terakhir)", () => {
    const m15: Candle[] = [0, 1, 2, 3, 4].map((i) => ({ time: 3600 + i * 900, open: 10 + i, high: 11 + i, low: 9 + i, close: 10.5 + i }));
    expect(aggregateCandles(m15, 3600)).toEqual([
      { time: 3600, open: 10, high: 14, low: 9, close: 13.5 },
      { time: 7200, open: 14, high: 15, low: 13, close: 14.5 },
    ]);
  });

  it("EUR/USD turun di M15 & H1 → USD menguat skor +2; naik → −2; data kurang → 0", () => {
    expect(usdPriceTrend(eurusd(400, -0.00005)).score).toBe(2);
    expect(usdPriceTrend(eurusd(400, 0.00005)).score).toBe(-2);
    expect(usdPriceTrend(eurusd(20, -0.00005))).toMatchObject({ score: 0 });
  });

  it("nada berita USD dari aturan News AI, negasi membalik; satu suara per berita", () => {
    const n = (...ids: string[]) => ({ rule_ids: ids });
    const t = usdNewsTone([n("usd_strong", "fx_usd_strong"), n("fed_hawkish"), n("yields_up"), n("fed_dovish:neg"), n("usd_weak"), n("price_down")]);
    expect(t).toMatchObject({ up: 4, down: 1, score: 1 });
  });

  it("tren XAU M15 & H1 turun → mendukung USD menguat", () => {
    expect(xauTrendSupport({ M15: "bearish", H1: "bearish" }).score).toBe(1);
    expect(xauTrendSupport({ M15: "bullish", H1: "ranging" }).score).toBe(0);
  });

  it("harga menentukan, pendukung mengonfirmasi: searah → kuat; tanpa/berlawanan → lemah; harga datar → NETRAL", () => {
    const p = (score: number) => ({ score, reasons: [] });
    expect(usdBias(p(2), p(1), p(1))).toMatchObject({ usd: "BULLISH", xau: "SELL", strength: "kuat" });
    expect(usdBias(p(1), p(1), p(0))).toMatchObject({ usd: "BULLISH", xau: "SELL", strength: "sedang" });
    const against = usdBias(p(-2), p(1), p(0));
    expect(against).toMatchObject({ usd: "BEARISH", xau: "BUY", strength: "lemah" });
    expect(against.reasons.at(-1)).toMatch(/berlawanan/);
    expect(usdBias(p(0), p(2), p(1))).toMatchObject({ usd: "NETRAL", xau: "NETRAL", strength: null });
  });
});

describe("prediksi rilis memakai USD sebagai penentu utama", () => {
  const nfp = [{ title: "Non-Farm Employment Change", time_at: "2026-11-06T13:30:00Z", forecast: "65K", previous: "29K" }];
  const t = Date.parse("2026-11-06T10:00:00Z");
  it("Bullish USD + ekspektasi NFP kuat (SELL emas) → SELL sedang", () => {
    expect(eventBias(nfp, [], t, { usd: "BULLISH", strength: "kuat" })).toMatchObject({ side: "SELL", usd: "BULLISH", strength: "sedang" });
  });
  it("Bearish USD tetap menentukan BUY walau ekspektasi NFP mendukung SELL → lemah, ditandai berlawanan", () => {
    const b = eventBias(nfp, [], t, { usd: "BEARISH", strength: "sedang" });
    expect(b).toMatchObject({ side: "BUY", usd: "BEARISH", strength: "lemah" });
    expect(b.reasons.at(-1)).toMatch(/berlawanan/);
  });
  it("USD netral → kembali ke ekspektasi & berita", () => {
    const b = eventBias(nfp, [], t, { usd: "NETRAL", strength: null });
    expect(b).toMatchObject({ side: "SELL", usd: "BULLISH" });
    expect(b.reasons[0]).toMatch(/belum jelas/);
  });
});
