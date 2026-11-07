/**
 * Arah USD hari ini → sinyal XAUUSD (7 Nov 2026, permintaan pengguna: "USD dulu, data lain pendukung").
 *
 * Penentu utama: tren harga EUR/USD (Twelve Data) M15 & H1 — EUR/USD turun = USD menguat. Pendukung:
 * nada berita USD 24 jam (dollar/pasangan mata uang, imbal hasil, Fed, data & inflasi AS) dan tren XAU M15–H1
 * dari engine. XAUUSD = kebalikan USD. Berbasis aturan, bukan model AI; belum teruji.
 */
import type { Candle, MarketBias } from "./types.ts";
import { analyzeTimeframe } from "./analysis.ts";

export type UsdSide = "BULLISH" | "BEARISH" | "NETRAL";
export type XauSide = "BUY" | "SELL" | "NETRAL";

export interface UsdBias {
  usd: UsdSide;
  xau: XauSide;
  strength: "lemah" | "sedang" | "kuat" | null;
  /** skor dalam satuan USD: + = USD menguat */
  score: number;
  parts: { price: number; news: number; xau: number };
  reasons: string[];
}

/** Gabungkan candle kecil menjadi TF lebih besar (mis. M15 → H1) berdasarkan awal periode. */
export function aggregateCandles(candles: Candle[], periodSec: number): Candle[] {
  const out: Candle[] = [];
  for (const c of candles) {
    const t = Math.floor(c.time / periodSec) * periodSec;
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
    } else out.push({ time: t, open: c.open, high: c.high, low: c.low, close: c.close });
  }
  return out;
}

const usdOf = (eurBias: MarketBias | undefined): number => (eurBias === "bearish" ? 1 : eurBias === "bullish" ? -1 : 0);
const word = (d: number) => (d > 0 ? "menguat" : d < 0 ? "melemah" : "datar/ranging");

/** Tren USD dari EUR/USD M15 (dan H1 hasil gabungan M15). Candle harus tertutup. Skor −2..+2 (USD). */
export function usdPriceTrend(eurusdM15: Candle[]): { score: number; reasons: string[] } {
  const m15 = analyzeTimeframe("M15", eurusdM15);
  const h1 = analyzeTimeframe("H1", aggregateCandles(eurusdM15, 3600));
  if (!m15) return { score: 0, reasons: ["Data EUR/USD belum cukup untuk membaca tren USD."] };
  const a = usdOf(m15.bias);
  const b = usdOf(h1?.bias);
  const reasons = [
    `EUR/USD M15 ${m15.bias} (${m15.structure.label}) → USD ${word(a)}.`,
    h1 ? `EUR/USD H1 ${h1.bias} (${h1.structure.label}) → USD ${word(b)}.` : "EUR/USD H1 belum cukup data.",
  ];
  // searah = 2; satu berarah, satu datar = 1; berlawanan = 0
  const score = a && b ? (a === b ? 2 * a : 0) : a + b;
  return { score, reasons };
}

// arah USD per aturan News AI (+ = USD menguat)
const USD_RULE: Record<string, number> = {
  usd_strong: 1, fx_usd_strong: 1, yields_up: 1, fed_hawkish: 1, us_data_strong: 1, inflation_hot: 1, inflation_up: 1,
  usd_weak: -1, fx_usd_weak: -1, yields_down: -1, fed_dovish: -1, us_data_weak: -1, inflation_cool: -1,
};

/** Nada berita USD: tiap berita bersuara sekali (+1/−1) dari aturan USD-nya. Skor −2..+2. */
export function usdNewsTone(news: { rule_ids: string[] | null }[]): { score: number; up: number; down: number; reasons: string[] } {
  let up = 0;
  let down = 0;
  for (const n of news) {
    let s = 0;
    for (const id of n.rule_ids ?? []) {
      const [rule, neg] = id.split(":");
      s += (USD_RULE[rule] ?? 0) * (neg ? -1 : 1);
    }
    if (s > 0) up++;
    else if (s < 0) down++;
  }
  const net = up - down;
  const score = Math.abs(net) >= 6 ? 2 * Math.sign(net) : Math.abs(net) >= 3 ? Math.sign(net) : 0;
  const reasons = [up + down ? `Berita USD 24 jam: ${up} menguatkan vs ${down} melemahkan USD → ${score ? `USD ${word(score)}` : "belum tegas"}.` : "Belum ada berita USD berarah dalam 24 jam."];
  return { score, up, down, reasons };
}

/** Tren XAU dari engine (M15 & H1): emas naik = USD cenderung melemah. Skor −1..+1 (USD). */
export function xauTrendSupport(bias: { M15?: MarketBias; H1?: MarketBias }): { score: number; reasons: string[] } {
  const g = (b?: MarketBias) => (b === "bullish" ? 1 : b === "bearish" ? -1 : 0);
  const s = g(bias.M15) + g(bias.H1);
  const score = s >= 2 ? -1 : s <= -2 ? 1 : 0;
  return { score, reasons: [`XAUUSD M15 ${bias.M15 ?? "—"}, H1 ${bias.H1 ?? "—"} → ${score ? `searah USD ${word(score)}` : "belum searah"}.`] };
}

/**
 * Kesimpulan: arah USD ditentukan harga EUR/USD; berita & tren XAU hanya mengonfirmasi.
 * Harga datar → NETRAL. Pendukung searah → sedang/kuat; tanpa dukungan atau berlawanan → lemah (tetap ikut harga).
 */
export function usdBias(price: { score: number; reasons: string[] }, news: { score: number; reasons: string[] }, xau: { score: number; reasons: string[] }): UsdBias {
  const p = price.score;
  const support = news.score + xau.score;
  const reasons = [...price.reasons, ...news.reasons, ...xau.reasons];
  if (p === 0) {
    return { usd: "NETRAL", xau: "NETRAL", strength: null, score: 0, parts: { price: p, news: news.score, xau: xau.score }, reasons: [...reasons, "Kesimpulan: tren EUR/USD belum jelas → arah USD belum bisa diputuskan."] };
  }
  const dir = Math.sign(p);
  const agree = Math.sign(support) === dir;
  const oppose = support !== 0 && !agree;
  const strength = agree ? (Math.abs(p) === 2 && Math.abs(support) >= 2 ? "kuat" : "sedang") : "lemah";
  const usd: UsdSide = dir > 0 ? "BULLISH" : "BEARISH";
  const xauSide: XauSide = dir > 0 ? "SELL" : "BUY";
  reasons.push(`Kesimpulan: USD ${dir > 0 ? "menguat (Bullish USD)" : "melemah (Bearish USD)"} ${agree ? "dan dikonfirmasi data pendukung" : oppose ? "tetapi data pendukung berlawanan — hati-hati" : "tanpa konfirmasi data pendukung"} → XAUUSD ${xauSide}.`);
  return { usd, xau: xauSide, strength, score: p + support, parts: { price: p, news: news.score, xau: xau.score }, reasons };
}
