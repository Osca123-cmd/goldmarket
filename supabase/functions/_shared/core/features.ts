import type { Candle, Direction, MarketBias } from "./types.ts";
import type { SetupCandidate, DetectContext } from "./strategies.ts";
import { priceToPips, type InstrumentSpec } from "./instrument.ts";

/**
 * Ciri (features) sebuah setup pada saat dibuat — dipakai untuk RISET filter di
 * backtest (disimpan per trade), bukan untuk skor. Semua arah dinormalkan ke arah
 * setup: nilai positif = mendukung arah setup.
 */
export interface SetupFeatures {
  score: number;
  trendPts: number;
  structPts: number;
  candlePts: number;
  momPts: number;
  volPts: number;
  h4: MarketBias | null;
  h1: MarketBias | null;
  strong: boolean;
  /** +1 bias H4 searah setup, 0 ranging, −1 berlawanan */
  alignH4: number;
  /** +1 harga di sisi EMA200 H4 yang searah setup, −1 berlawanan, 0 tidak ada */
  ema200H4: number;
  /** kemiringan EMA50 H4 (ATR/5 bar) dikali arah */
  slopeH4: number;
  rsiCtx: number | null;
  /** RSI konteks dinormalkan ke arah: BUY = rsi, SELL = 100 − rsi */
  rsiDir: number | null;
  atrCtxPips: number;
  atrH1Pips: number | null;
  slAtrCtx: number;
  zoneAtr: number;
  distAtr: number;
  confirmed: boolean;
  entryType: string;
  /** ruang dari entry ke high (BUY) / low (SELL) hari sebelumnya, dalam ATR H1; negatif = sudah melewatinya */
  roomPrevDayAtr: number | null;
  /** jarak entry ke level hari sebelumnya yang berlawanan (low untuk BUY / high untuk SELL), ATR H1 */
  backPrevDayAtr: number | null;
  /** jarak entry ke kelipatan $10 / $50 terdekat (pips) */
  round10Pips: number;
  round50Pips: number;
  /** posisi entry terhadap range sesi Asia hari ini (00–07 UTC), searah setup: +1 sudah tembus searah, 0 di dalam, −1 di sisi berlawanan, null bila belum ada */
  asiaRel: number | null;
  hourUtc: number;
  dow: number;
}

const sgn = (d: Direction) => (d === "BUY" ? 1 : -1);
const r2 = (x: number) => Math.round(x * 100) / 100;

export function prevDayRange(h1: Candle[], nowSec: number): { high: number; low: number } | null {
  const today = Math.floor(nowSec / 86400);
  let day = -1;
  for (let i = h1.length - 1; i >= 0; i--) {
    const d = Math.floor(h1[i].time / 86400);
    if (d < today) {
      day = d;
      break;
    }
  }
  if (day < 0) return null;
  const bars = h1.filter((c) => Math.floor(c.time / 86400) === day);
  return { high: Math.max(...bars.map((c) => c.high)), low: Math.min(...bars.map((c) => c.low)) };
}

export function asiaRange(m15: Candle[], nowSec: number): { high: number; low: number } | null {
  const dayStart = Math.floor(nowSec / 86400) * 86400;
  if (nowSec < dayStart + 7 * 3600) return null; // range Asia belum selesai
  const bars = m15.filter((c) => c.time >= dayStart && c.time + 900 <= dayStart + 7 * 3600);
  if (bars.length < 8) return null;
  return { high: Math.max(...bars.map((c) => c.high)), low: Math.min(...bars.map((c) => c.low)) };
}

function roundDist(price: number, step: number, spec: InstrumentSpec): number {
  const nearest = Math.round(price / step) * step;
  return Math.abs(priceToPips(price - nearest, spec));
}

export function setupFeatures(s: SetupCandidate, c: DetectContext): SetupFeatures {
  const spec = c.config.spec;
  const d = sgn(s.direction);
  const a = c.analysis.tfs;
  const ctx = a[s.timeframe];
  const atrCtx = ctx?.atr ?? 0;
  const h4 = a.H4;
  const h1 = a.H1;
  const comp = Object.fromEntries(s.score.components.map((x) => [x.key, x.points]));
  const biasSign = (b: MarketBias | undefined) => (b === "bullish" ? 1 : b === "bearish" ? -1 : 0);
  const pd = prevDayRange(c.candles.H1 ?? [], c.nowSec);
  const asia = asiaRange(c.candles.M15 ?? [], c.nowSec);
  const atrH1 = h1?.atr ?? null;
  const rsi = ctx && Number.isFinite(ctx.rsi) ? ctx.rsi : null;
  const t = new Date(c.nowSec * 1000);
  return {
    score: s.score.total,
    trendPts: comp.trend ?? 0,
    structPts: comp.structure ?? 0,
    candlePts: comp.candle ?? 0,
    momPts: comp.momentum ?? 0,
    volPts: comp.volatilityCost ?? 0,
    h4: h4?.bias ?? null,
    h1: h1?.bias ?? null,
    strong: c.analysis.strongBias,
    alignH4: d * biasSign(h4?.bias),
    ema200H4: h4 && Number.isFinite(h4.ema200) ? (d * (h4.lastClose - h4.ema200) > 0 ? 1 : -1) : 0,
    slopeH4: h4 ? r2(d * h4.ema50SlopeAtr) : 0,
    rsiCtx: rsi != null ? r2(rsi) : null,
    rsiDir: rsi != null ? r2(d > 0 ? rsi : 100 - rsi) : null,
    atrCtxPips: r2(priceToPips(atrCtx, spec)),
    atrH1Pips: atrH1 != null ? r2(priceToPips(atrH1, spec)) : null,
    slAtrCtx: atrCtx ? r2(Math.abs(s.entry - s.sl) / atrCtx) : 0,
    zoneAtr: atrCtx ? r2((s.entryHigh - s.entryLow) / atrCtx) : 0,
    distAtr: atrCtx ? r2(Math.abs(c.price - s.entry) / atrCtx) : 0,
    confirmed: s.confirmed,
    entryType: s.entryType,
    roomPrevDayAtr: pd && atrH1 ? r2((d > 0 ? pd.high - s.entry : s.entry - pd.low) / atrH1) : null,
    backPrevDayAtr: pd && atrH1 ? r2((d > 0 ? s.entry - pd.low : pd.high - s.entry) / atrH1) : null,
    round10Pips: r2(roundDist(s.entry, 10, spec)),
    round50Pips: r2(roundDist(s.entry, 50, spec)),
    asiaRel: asia ? (d > 0 ? (s.entry > asia.high ? 1 : s.entry < asia.low ? -1 : 0) : s.entry < asia.low ? 1 : s.entry > asia.high ? -1 : 0) : null,
    hourUtc: t.getUTCHours(),
    dow: t.getUTCDay(),
  };
}
