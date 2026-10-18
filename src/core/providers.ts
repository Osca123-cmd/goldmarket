import type { Candle, Quote, Timeframe } from "./types.ts";
import { TF_SECONDS } from "./types.ts";
import { isMarketOpenBySchedule } from "./sessions.ts";

/**
 * Abstraksi provider data pasar. Dipanggil HANYA dari server (Edge Function);
 * API key dibaca dari environment server dan tidak pernah dikirim ke browser.
 */
export interface MarketProvider {
  id: "twelvedata" | "td_hybrid" | "binance_paxg" | "spot_hybrid" | "demo";
  label: string;
  symbol: string;
  isDemo: boolean;
  /** instrumen bukan XAUUSD spot (proxy) — harus ditampilkan ke pengguna */
  proxyNote: string | null;
  supportsBidAsk: boolean;
  fetchQuote(nowSec: number): Promise<Quote>;
  fetchCandles(tf: Timeframe, limit: number, endSec?: number): Promise<Candle[]>;
  /** spot_hybrid/td_hybrid: selisih XAU spot − PAXG (spot_hybrid: penggeser candle; td_hybrid: hanya open/high/low harian) */
  basis?: number | null;
  /** keterangan sumber harga quote terakhir (mis. fallback) */
  lastQuoteNote?: string | null;
}

export class ProviderError extends Error {
  constructor(message: string, public readonly rateLimited = false, public readonly status?: number) {
    super(message);
  }
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

async function getJson(fetchFn: Fetch, url: string, redact?: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { accept: "application/json" } });
  } catch (e) {
    throw new ProviderError(`Jaringan gagal: ${(e as Error).message}`.replace(redact ?? "\u0000", "***"));
  }
  if (res.status === 429) throw new ProviderError("Rate limit provider (HTTP 429)", true, 429);
  if (!res.ok) throw new ProviderError(`HTTP ${res.status} dari provider`, false, res.status);
  return res.json();
}

// ---------------------------------------------------------------------------
// Twelve Data (REST). XAU/USD. Free plan: 8 kredit/menit, 800/hari — atur
// interval polling. WebSocket Twelve Data memerlukan paket berbayar.
// ---------------------------------------------------------------------------
const TD_INTERVAL: Record<Timeframe, string> = {
  M1: "1min", M5: "5min", M15: "15min", M30: "30min", H1: "1h", H4: "4h", D1: "1day",
};

export function parseTwelveDataSeries(json: unknown): Candle[] {
  const j = json as { status?: string; code?: number; message?: string; values?: Record<string, string>[] };
  if (j.status === "error") throw new ProviderError(`Twelve Data: ${j.message ?? "error"}`, j.code === 429, j.code);
  return (j.values ?? []).map((v) => ({
    time: Math.floor(Date.parse(v.datetime.replace(" ", "T") + (v.datetime.length > 10 ? "Z" : "T00:00:00Z")) / 1000),
    open: Number(v.open),
    high: Number(v.high),
    low: Number(v.low),
    close: Number(v.close),
    volume: v.volume ? Number(v.volume) : undefined,
  }));
}

export function parseTwelveDataQuote(json: unknown): Quote {
  const j = json as Record<string, unknown>;
  if (j.status === "error") throw new ProviderError(`Twelve Data: ${String(j.message ?? "error")}`, j.code === 429, Number(j.code));
  const price = Number(j.close);
  if (!Number.isFinite(price)) throw new ProviderError("Twelve Data: quote tidak berisi harga");
  return {
    price,
    time: Number(j.last_quote_at ?? j.timestamp),
    dayOpen: Number(j.open),
    dayHigh: Number(j.high),
    dayLow: Number(j.low),
    marketOpen: typeof j.is_market_open === "boolean" ? (j.is_market_open as boolean) : undefined,
  };
}

export function twelveData(apiKey: string, fetchFn: Fetch = fetch): MarketProvider {
  const base = "https://api.twelvedata.com";
  const sym = encodeURIComponent("XAU/USD");
  return {
    id: "twelvedata",
    label: "Twelve Data — XAU/USD",
    symbol: "XAU/USD",
    isDemo: false,
    proxyNote: null,
    supportsBidAsk: false,
    async fetchQuote() {
      return parseTwelveDataQuote(await getJson(fetchFn, `${base}/quote?symbol=${sym}&timezone=UTC&apikey=${apiKey}`, apiKey));
    },
    async fetchCandles(tf, limit) {
      const url = `${base}/time_series?symbol=${sym}&interval=${TD_INTERVAL[tf]}&outputsize=${Math.min(limit, 5000)}&timezone=UTC&order=ASC&apikey=${apiKey}`;
      return parseTwelveDataSeries(await getJson(fetchFn, url, apiKey));
    },
  };
}

// ---------------------------------------------------------------------------
// Binance PAXG/USDT (data publik, tanpa API key). PAXG adalah token emas
// (1 PAXG = 1 troy ounce) — PROXY, bukan XAUUSD spot: harga bisa selisih
// beberapa dolar dan diperdagangkan 24/7. Analisis tetap mengikuti jam pasar
// emas (sinyal baru tidak dibuat saat pasar emas tutup).
// ---------------------------------------------------------------------------
const BN_INTERVAL: Record<Timeframe, string> = {
  M1: "1m", M5: "5m", M15: "15m", M30: "30m", H1: "1h", H4: "4h", D1: "1d",
};

export function parseBinanceKlines(json: unknown): Candle[] {
  if (!Array.isArray(json)) throw new ProviderError("Binance: format klines tidak dikenal");
  return (json as unknown[][]).map((k) => ({
    time: Math.floor(Number(k[0]) / 1000),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));
}

export function binancePaxg(fetchFn: Fetch = fetch): MarketProvider {
  const base = "https://data-api.binance.vision/api/v3";
  return {
    id: "binance_paxg",
    label: "Binance — PAXG/USDT (proxy emas)",
    symbol: "PAXGUSDT",
    isDemo: false,
    proxyNote:
      "Sumber adalah PAXG/USDT (token emas), bukan XAUUSD spot broker. Selisih harga terhadap XAUUSD broker Anda bisa beberapa dolar dan spread berbeda.",
    supportsBidAsk: true,
    async fetchQuote(nowSec) {
      const [book, day] = await Promise.all([
        getJson(fetchFn, `${base}/ticker/bookTicker?symbol=PAXGUSDT`) as Promise<{ bidPrice: string; askPrice: string }>,
        getJson(fetchFn, `${base}/klines?symbol=PAXGUSDT&interval=1d&limit=1`),
      ]);
      const d = parseBinanceKlines(day)[0];
      const bid = Number(book.bidPrice);
      const ask = Number(book.askPrice);
      if (!(bid > 0 && ask > 0)) throw new ProviderError("Binance: bid/ask kosong");
      return {
        price: (bid + ask) / 2,
        bid,
        ask,
        time: nowSec, // bookTicker adalah snapshot saat permintaan
        dayOpen: d?.open,
        dayHigh: d ? Math.max(d.high, ask) : undefined,
        dayLow: d ? Math.min(d.low, bid) : undefined,
        marketOpen: isMarketOpenBySchedule(nowSec * 1000),
      };
    },
    async fetchCandles(tf, limit, endSec) {
      const out: Candle[] = [];
      let end = endSec ? endSec * 1000 : undefined;
      let remaining = limit;
      while (remaining > 0) {
        const n = Math.min(1000, remaining);
        const url = `${base}/klines?symbol=PAXGUSDT&interval=${BN_INTERVAL[tf]}&limit=${n}${end ? `&endTime=${end}` : ""}`;
        const batch = parseBinanceKlines(await getJson(fetchFn, url));
        if (batch.length === 0) break;
        out.unshift(...batch);
        remaining -= batch.length;
        if (batch.length < n) break;
        end = batch[0].time * 1000 - 1;
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Spot hybrid (tanpa API key): HARGA = XAU spot dari gold-api.com; CANDLE =
// PAXG/USDT digeser "basis" (spot − PAXG mid) agar level sejajar harga spot.
// Bila gold-api gagal, harga = PAXG mid + basis terakhir (ditandai).
// ---------------------------------------------------------------------------
export function parseGoldApi(json: unknown): { price: number; time: number } {
  const j = json as { price?: number; updatedAt?: string; symbol?: string };
  const price = Number(j.price);
  if (!Number.isFinite(price) || price <= 0) throw new ProviderError("gold-api: harga tidak valid");
  const t = j.updatedAt ? Date.parse(j.updatedAt) : NaN;
  return { price, time: Number.isFinite(t) ? Math.floor(t / 1000) : NaN };
}

export function shiftCandles(candles: Candle[], basis: number): Candle[] {
  return candles.map((c) => ({ ...c, open: c.open + basis, high: c.high + basis, low: c.low + basis, close: c.close + basis }));
}

export function spotHybrid(initialBasis: number | null, fetchFn: Fetch = fetch): MarketProvider {
  const paxg = binancePaxg(fetchFn);
  const p: MarketProvider = {
    id: "spot_hybrid",
    label: "XAU spot (gold-api.com) · candle PAXG disesuaikan",
    symbol: "XAUUSD",
    isDemo: false,
    proxyNote:
      "Harga = XAU spot (gold-api.com). Candle untuk chart & analisis = PAXG/USDT yang digeser selisih (basis) terhadap spot. Harga broker Anda bisa berbeda beberapa sen hingga dolar karena bid/ask, spread, dan feed broker.",
    supportsBidAsk: false,
    basis: initialBasis,
    lastQuoteNote: null,
    async fetchQuote(nowSec) {
      const [spotRes, pq] = await Promise.allSettled([getJson(fetchFn, "https://api.gold-api.com/price/XAU").then(parseGoldApi), paxg.fetchQuote(nowSec)]);
      if (pq.status === "rejected" && spotRes.status === "rejected") throw spotRes.reason;
      const marketOpen = isMarketOpenBySchedule(nowSec * 1000);
      if (spotRes.status === "fulfilled") {
        const spot = spotRes.value;
        const spotTime = Number.isFinite(spot.time) ? spot.time : nowSec;
        // basis diperbarui saat pasar emas buka & harga spot segar (atau bila belum pernah ada)
        if (pq.status === "fulfilled" && ((marketOpen && nowSec - spotTime < 300) || p.basis == null)) {
          p.basis = spot.price - pq.value.price;
        }
        p.lastQuoteNote = null;
        const b = p.basis ?? 0;
        const d = pq.status === "fulfilled" ? pq.value : null;
        return {
          price: spot.price,
          time: spotTime,
          dayOpen: d?.dayOpen != null ? d.dayOpen + b : undefined,
          dayHigh: d?.dayHigh != null ? Math.max(d.dayHigh + b, spot.price) : undefined,
          dayLow: d?.dayLow != null ? Math.min(d.dayLow + b, spot.price) : undefined,
          marketOpen,
        };
      }
      const q = (pq as PromiseFulfilledResult<Quote>).value;
      const b = p.basis ?? 0;
      p.lastQuoteNote = "gold-api tidak merespons: harga sementara = PAXG + basis terakhir.";
      return { ...q, bid: undefined, ask: undefined, price: q.price + b, dayOpen: q.dayOpen != null ? q.dayOpen + b : undefined, dayHigh: q.dayHigh != null ? q.dayHigh + b : undefined, dayLow: q.dayLow != null ? q.dayLow + b : undefined };
    },
    async fetchCandles(tf, limit, endSec) {
      if (p.basis == null) throw new ProviderError("Basis spot−PAXG belum tersedia");
      return shiftCandles(await paxg.fetchCandles(tf, limit, endSec), p.basis);
    },
  };
  return p;
}

// ---------------------------------------------------------------------------
// Twelve Data hybrid (default bila TWELVEDATA_API_KEY ada): HARGA = XAU spot
// gold-api.com seperti spot_hybrid (gratis, tiap menit); CANDLE = XAU/USD asli
// Twelve Data tanpa penggeseran. Quote Twelve Data tidak dipakai agar kredit
// paket gratis (800/hari) cukup untuk candle saja (~470/hari tanpa M1).
// ---------------------------------------------------------------------------
export function tdHybrid(apiKey: string, initialBasis: number | null, fetchFn: Fetch = fetch): MarketProvider {
  const spot = spotHybrid(initialBasis, fetchFn);
  const td = twelveData(apiKey, fetchFn);
  const p: MarketProvider = {
    id: "td_hybrid",
    label: "XAU spot (gold-api.com) · candle XAU/USD Twelve Data",
    symbol: "XAUUSD",
    isDemo: false,
    proxyNote:
      "Harga = XAU spot (gold-api.com). Candle untuk chart & analisis = XAU/USD dari Twelve Data. Open/high/low harian diperkirakan dari PAXG + basis. Harga broker Anda bisa berbeda beberapa sen hingga dolar karena bid/ask, spread, dan feed broker.",
    supportsBidAsk: false,
    basis: initialBasis,
    lastQuoteNote: null,
    async fetchQuote(nowSec) {
      const q = await spot.fetchQuote(nowSec);
      p.basis = spot.basis;
      p.lastQuoteNote = spot.lastQuoteNote;
      return q;
    },
    fetchCandles: (tf, limit, endSec) => td.fetchCandles(tf, limit, endSec),
  };
  return p;
}

/** Provider yang candle-nya dari Twelve Data (kredit terbatas): ambil hanya saat bar baru, tanpa M1. */
export function usesTwelveDataCandles(id: string | null | undefined): boolean {
  return id === "twelvedata" || id === "td_hybrid";
}

// ---------------------------------------------------------------------------
// Demo: data SIMULASI deterministik (fungsi waktu). Selalu berstatus "Demo".
// ---------------------------------------------------------------------------
function hashNoise(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return ((x >>> 0) / 4294967295) * 2 - 1;
}

export function demoPrice(minute: number): number {
  const t = minute;
  return (
    3000 +
    40 * Math.sin(t / 9000) +
    18 * Math.sin(t / 1700 + 1.3) +
    7 * Math.sin(t / 380 + 0.4) +
    2.5 * Math.sin(t / 61 + 2.1) +
    0.9 * hashNoise(t) +
    0.5 * hashNoise(Math.floor(t / 7))
  );
}

export function demoCandle(tf: Timeframe, openSec: number): Candle {
  const m0 = Math.floor(openSec / 60);
  const mins = TF_SECONDS[tf] / 60;
  const stride = Math.max(1, Math.floor(mins / 240));
  let high = -Infinity;
  let low = Infinity;
  for (let m = m0; m < m0 + mins; m += stride) {
    const p = demoPrice(m);
    high = Math.max(high, p + 0.3);
    low = Math.min(low, p - 0.3);
  }
  const open = demoPrice(m0);
  const close = demoPrice(m0 + mins - 1);
  return { time: openSec, open, high: Math.max(high, open, close), low: Math.min(low, open, close), close };
}

/** Bar dianggap ada bila pasar buka pada sebagian rentangnya. */
export function barOverlapsMarket(openSec: number, step: number): boolean {
  for (let t = openSec; t < openSec + step; t += Math.max(60, Math.floor(step / 8))) {
    if (isMarketOpenBySchedule(t * 1000)) return true;
  }
  return isMarketOpenBySchedule((openSec + step - 60) * 1000);
}

/**
 * Hanya bar yang (sebagian) berada dalam jam pasar emas. Feed proxy 24/7 (PAXG)
 * tetap bergerak saat akhir pekan & jeda harian — bar itu bukan harga emas dan
 * akan mencemari indikator, struktur, dan backtest.
 */
export function marketHoursOnly(candles: Candle[], tf: Timeframe): Candle[] {
  const step = TF_SECONDS[tf];
  return candles.filter((c) => barOverlapsMarket(c.time, step));
}

export function demoProvider(): MarketProvider {
  return {
    id: "demo",
    label: "Demo — data simulasi",
    symbol: "XAUUSD (simulasi)",
    isDemo: true,
    proxyNote: "Data SIMULASI untuk demonstrasi. Bukan harga pasar.",
    supportsBidAsk: true,
    async fetchQuote(nowSec) {
      const p = demoPrice(nowSec / 60);
      const dayStart = nowSec - (nowSec % 86400);
      const d = demoCandle("D1", dayStart);
      return { price: p, bid: p - 0.15, ask: p + 0.15, time: nowSec, dayOpen: d.open, dayHigh: d.high, dayLow: d.low, marketOpen: isMarketOpenBySchedule(nowSec * 1000) };
    },
    async fetchCandles(tf, limit, endSec) {
      const step = TF_SECONDS[tf];
      const now = endSec ?? Math.floor(Date.now() / 1000);
      const lastOpen = now - (now % step);
      const out: Candle[] = [];
      for (let t = lastOpen - (limit - 1) * step; t <= lastOpen; t += step) {
        if (step < 86400 && !barOverlapsMarket(t, step)) continue;
        out.push(demoCandle(tf, t));
      }
      return out;
    },
  };
}

export function createProvider(id: string | undefined, env: { twelveDataKey?: string; basis?: number | null }, fetchFn: Fetch = fetch): MarketProvider {
  if (id === "spot_hybrid") return spotHybrid(env.basis ?? null, fetchFn);
  if (id === "twelvedata" || id === "td_hybrid") {
    if (!env.twelveDataKey) throw new ProviderError("TWELVEDATA_API_KEY belum diset");
    return id === "td_hybrid" ? tdHybrid(env.twelveDataKey, env.basis ?? null, fetchFn) : twelveData(env.twelveDataKey, fetchFn);
  }
  if (id === "binance_paxg") return binancePaxg(fetchFn);
  return demoProvider();
}
