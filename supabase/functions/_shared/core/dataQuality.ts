import type { Candle, FeedStatus, Timeframe } from "./types.ts";
import { TF_SECONDS } from "./types.ts";
import { DEFAULT_SCHEDULE, isMarketOpenBySchedule, type TradingSchedule } from "./sessions.ts";

/** Urutkan berdasarkan waktu, buang duplikat (bar terakhir menang) dan bar OHLC tidak valid. */
export function dedupeCandles(candles: Candle[]): Candle[] {
  const map = new Map<number, Candle>();
  for (const c of candles) {
    if (!isSaneCandle(c)) continue;
    map.set(c.time, c);
  }
  return [...map.values()].sort((a, b) => a.time - b.time);
}

export function isSaneCandle(c: Candle): boolean {
  const vals = [c.open, c.high, c.low, c.close];
  if (!vals.every((v) => Number.isFinite(v) && v > 0)) return false;
  if (!Number.isFinite(c.time)) return false;
  return c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close);
}

/** Bar dianggap tertutup bila waktu buka + durasi TF <= now. */
export function isClosed(c: Candle, tf: Timeframe, nowSec: number): boolean {
  return c.time + TF_SECONDS[tf] <= nowSec;
}

/** Hanya candle yang sudah ditutup pada `nowSec`. Dipakai untuk konfirmasi sinyal dan backtest (anti look-ahead). */
export function closedAsOf(candles: Candle[], tf: Timeframe, nowSec: number): Candle[] {
  let end = candles.length;
  while (end > 0 && !isClosed(candles[end - 1], tf, nowSec)) end--;
  return end === candles.length ? candles : candles.slice(0, end);
}

/**
 * Cari candle hilang di `lookbackBars` bar terakhir. Celah saat pasar tutup
 * (akhir pekan / jeda harian / libur) tidak dihitung.
 */
export function findGaps(
  candles: Candle[],
  tf: Timeframe,
  lookbackBars = 30,
  schedule: TradingSchedule = DEFAULT_SCHEDULE,
): number[] {
  const step = TF_SECONDS[tf];
  const recent = candles.slice(-lookbackBars);
  const missing: number[] = [];
  // Untuk TF >= H4, jadwal bar provider tidak selalu sejajar jam pasar; cek longgar.
  if (step >= 14400) return missing;
  for (let i = 1; i < recent.length; i++) {
    for (let t = recent[i - 1].time + step; t < recent[i].time; t += step) {
      if (isMarketOpenBySchedule(t * 1000, schedule) && isMarketOpenBySchedule((t + step - 1) * 1000, schedule)) {
        missing.push(t);
      }
    }
  }
  return missing;
}

export interface QualityThresholds {
  /** umur harga maksimum (detik) untuk berlabel Live */
  liveMaxAgeSec: number;
  /** umur harga maksimum (detik) sebelum sinyal baru diblokir */
  signalMaxAgeSec: number;
  /** jumlah candle hilang maksimum pada TF konfirmasi */
  maxGaps: number;
  /** spread maksimum (pips) agar setup baru boleh dibuat */
  maxSpreadPips: number;
}

export const DEFAULT_THRESHOLDS: QualityThresholds = {
  liveMaxAgeSec: 30,
  signalMaxAgeSec: 180,
  maxGaps: 0,
  maxSpreadPips: 8,
};

export interface QualityReport {
  ok: boolean;
  reasons: string[];
  quoteAgeSec: number;
  gaps: Partial<Record<Timeframe, number>>;
}

/**
 * Validasi kualitas data sebelum analisis membuat sinyal baru.
 * Gagal ⇒ sinyal baru tidak dibuat (setup lama tetap dipantau).
 */
export function assessQuality(args: {
  nowSec: number;
  quoteTimeSec: number | null;
  status: FeedStatus;
  candles: Partial<Record<Timeframe, Candle[]>>;
  requiredTfs: Timeframe[];
  minBars: number;
  spreadPips: number | null;
  thresholds?: QualityThresholds;
  schedule?: TradingSchedule;
}): QualityReport {
  const t = args.thresholds ?? DEFAULT_THRESHOLDS;
  const reasons: string[] = [];
  const gaps: Partial<Record<Timeframe, number>> = {};
  const age = args.quoteTimeSec == null ? Infinity : args.nowSec - args.quoteTimeSec;

  if (args.status === "disconnected" || args.status === "reconnecting") reasons.push(`Koneksi feed bermasalah (${args.status}).`);
  if (args.status === "market_closed") reasons.push("Pasar tutup menurut jadwal/provider.");
  if (!Number.isFinite(age) || age > t.signalMaxAgeSec) reasons.push(`Harga terlalu lama (umur ${Number.isFinite(age) ? Math.round(age) + " dtk" : "tidak diketahui"}).`);
  if (args.spreadPips != null && args.spreadPips > t.maxSpreadPips) reasons.push(`Spread ${args.spreadPips} pips melebihi batas ${t.maxSpreadPips} pips.`);

  for (const tf of args.requiredTfs) {
    const c = args.candles[tf] ?? [];
    if (c.length < args.minBars) {
      reasons.push(`Data ${tf} kurang (${c.length}/${args.minBars} bar).`);
      continue;
    }
    const lastClose = c[c.length - 1].time + TF_SECONDS[tf];
    // bar terakhir harus cukup baru (maks 2 bar tertinggal) bila pasar buka
    if (args.nowSec - lastClose > 2 * TF_SECONDS[tf] + 60 && isMarketOpenBySchedule(args.nowSec * 1000, args.schedule)) {
      reasons.push(`Candle ${tf} terakhir tertinggal ${Math.round((args.nowSec - lastClose) / 60)} menit.`);
    }
    const g = findGaps(c, tf, 30, args.schedule);
    gaps[tf] = g.length;
    if (g.length > t.maxGaps) reasons.push(`${g.length} candle ${tf} hilang pada 30 bar terakhir.`);
  }
  return { ok: reasons.length === 0, reasons, quoteAgeSec: age, gaps };
}

/** Status feed yang jujur: Live hanya jika data segar dan bukan simulasi. */
export function deriveFeedStatus(args: {
  isDemo: boolean;
  marketOpen: boolean;
  lastSuccessSec: number | null;
  quoteTimeSec: number | null;
  nowSec: number;
  consecutiveFailures: number;
  maxRetries: number;
  liveMaxAgeSec: number;
}): FeedStatus {
  if (args.isDemo) return "demo";
  if (args.consecutiveFailures >= args.maxRetries) return "disconnected";
  if (args.consecutiveFailures > 0) return "reconnecting";
  if (!args.marketOpen) return "market_closed";
  if (args.quoteTimeSec == null || args.lastSuccessSec == null) return "disconnected";
  return args.nowSec - args.quoteTimeSec <= args.liveMaxAgeSec ? "live" : "delayed";
}

/** Exponential backoff dengan batas (detik). */
export function backoffSeconds(failures: number, baseSec = 15, maxSec = 900): number {
  if (failures <= 0) return 0;
  return Math.min(maxSec, baseSec * 2 ** (failures - 1));
}
