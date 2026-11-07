import { describe, expect, it } from "vitest";
import { eventBias, parseEconValue, predictionHit, releaseGroups, releaseKey, releaseMoves, type NewsLike } from "../src/core/eventBias.ts";

// paket NFP nyata 6 Nov 2026 (feed ForexFactory)
const nfp = [
  { title: "Average Hourly Earnings m/m", time_at: "2026-11-06T13:30:00Z", forecast: "0.3%", previous: "0.1%" },
  { title: "Non-Farm Employment Change", time_at: "2026-11-06T13:30:00Z", forecast: "65K", previous: "29K" },
  { title: "Unemployment Rate", time_at: "2026-11-06T13:30:00Z", forecast: "4.2%", previous: "4.2%" },
];
const before = Date.parse("2026-11-06T10:00:00Z");
const news = (label: NewsLike["label"], confidence: NewsLike["confidence"], topic = "NFP", at = "2026-11-05T12:00:00Z"): NewsLike => ({ label, confidence, topic, published_at: at, created_at: at });

describe("perkiraan arah sebelum rilis", () => {
  it("angka feed: persen, K/M, minus, kosong", () => {
    expect([parseEconValue("0.3%"), parseEconValue("65K"), parseEconValue("-12.5K"), parseEconValue("1.2M"), parseEconValue("4.00%"), parseEconValue(null), parseEconValue("n/a")]).toEqual([0.3, 65000, -12500, 1200000, 4, null, null]);
  });

  it("NFP 6 Nov: NFP & upah diperkirakan naik → SELL; pengangguran sama → tanpa arah; skenario dari NFP", () => {
    const b = eventBias(nfp, [], before);
    expect(b).toMatchObject({ side: "SELL", strength: "lemah", score: -2 });
    expect(b.reasons.join(" ")).toMatch(/NFP: forecast 65K > previous 29K .* cenderung SELL/);
    expect(b.reasons.join(" ")).toMatch(/Pengangguran: forecast 4.2% ≈ previous 4.2%/);
    expect(b.scenario).toMatch(/^Saat rilis: NFP actual di atas forecast 65K → cenderung SELL; di bawah forecast → cenderung BUY/);
  });

  it("berita searah menaikkan kekuatan ke sedang; berita berlawanan bisa menetralkan", () => {
    const sells = [news("bearish", "sedang"), news("bearish", "tinggi"), news("bearish", "sedang")];
    expect(eventBias(nfp, sells, before)).toMatchObject({ side: "SELL", strength: "sedang", score: -4 });
    const buys = [news("bullish", "tinggi"), news("bullish", "tinggi")];
    expect(eventBias(nfp, buys, before)).toMatchObject({ side: "NETRAL", strength: null, score: 0 });
  });

  it("berita topik lain, lebih dari 72 jam, atau sesudah rilis tidak dihitung", () => {
    const ignored = [news("bullish", "tinggi", "CPI"), news("bullish", "tinggi", "NFP", "2026-11-01T00:00:00Z"), news("bullish", "tinggi", "NFP", "2026-11-06T14:00:00Z")];
    expect(eventBias(nfp, ignored, Date.parse("2026-11-06T15:00:00Z")).score).toBe(-2);
  });

  it("CPI di bawah previous → BUY; suku bunga tetap → netral dari ekspektasi, skenario nada pernyataan", () => {
    expect(eventBias([{ title: "CPI m/m", time_at: "2026-11-12T13:30:00Z", forecast: "0.2%", previous: "0.4%" }], [], before).side).toBe("BUY");
    const fomc = eventBias([{ title: "Federal Funds Rate", time_at: "2026-10-28T18:00:00Z", forecast: "4.00%", previous: "4.00%" }, { title: "FOMC Statement", time_at: "2026-10-28T18:00:00Z", forecast: null, previous: null }], [], before);
    expect(fomc.side).toBe("NETRAL");
    expect(fomc.scenario).toMatch(/hawkish SELL, dovish BUY/);
  });

  it("reaksi harga sesudah rilis dari candle M5 & penilaian prediksi", () => {
    const t = Date.parse("2026-11-06T13:30:00Z") / 1000;
    // harga turun 1 USD per bar M5 mulai bar rilis; bar terakhir sebelum rilis close 4062
    const bars = Array.from({ length: 60 }, (_, i) => ({ time: t - 300 * 6 + i * 300, close: i < 6 ? 4062 : 4062 - (i - 5) }));
    const m = releaseMoves(bars, t);
    expect(m).toEqual({ base: 4062, m15: -3, m60: -12, m240: -48 });
    expect(releaseMoves(bars.slice(0, 40), t)).toBeNull(); // 4 jam belum lewat
    expect(releaseMoves(bars.filter((b) => b.time < t || b.time >= t + 3600), t)).toBeNull(); // tanpa bar sesudah rilis (pasar tutup)
    expect([predictionHit("SELL", -12), predictionHit("BUY", -12), predictionHit("NETRAL", -12), predictionHit("SELL", 0)]).toEqual([true, false, null, null]);
    expect(releaseKey(nfp)).toBe("2026-11-06T13:30:00.000Z|NFP");
  });

  it("paket rilis: waktu & topik sama digabung", () => {
    const groups = releaseGroups([...nfp, { title: "CPI m/m", time_at: "2026-11-12T13:30:00Z", forecast: "0.2%", previous: "0.4%" }]);
    expect(groups.map((g) => g.length)).toEqual([3, 1]);
  });
});
