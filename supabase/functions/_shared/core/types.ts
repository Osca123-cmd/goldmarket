// Tipe bersama untuk seluruh modul inti. Modul di src/core tidak boleh
// bergantung pada Node, browser, atau Deno agar bisa dipakai di frontend,
// test (vitest), dan Supabase Edge Function.

export type Timeframe = "M1" | "M5" | "M15" | "M30" | "H1" | "H4" | "D1";

export const TIMEFRAMES: Timeframe[] = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"];

export const TF_SECONDS: Record<Timeframe, number> = {
  M1: 60,
  M5: 300,
  M15: 900,
  M30: 1800,
  H1: 3600,
  H4: 14400,
  D1: 86400,
};

/** Candle OHLC. `time` = waktu buka bar dalam detik UNIX (UTC). */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export type Direction = "BUY" | "SELL";
export type StrategyId = "trend_pullback" | "breakout_retest" | "liquidity_sweep" | "sd_reversal" | "crt" | "msnr_flip" | "fvg_retest" | "order_block" | "chop_breakout";
export type EntryType = "market" | "limit" | "stop";
/** jenis entry stop: in_zone = harga di dalam area tanpa konfirmasi (pemicu high/low candle); back_to_zone = harga di seberang area, masuk saat kembali */
export type StopKind = "in_zone" | "back_to_zone";

export type FeedStatus =
  | "live"
  | "delayed"
  | "reconnecting"
  | "disconnected"
  | "market_closed"
  | "demo";

export type MarketBias = "bullish" | "bearish" | "ranging";

export type AnalysisStatus =
  | "bullish"
  | "bearish"
  | "ranging"
  | "awaiting_confirmation"
  | "no_valid_setup";

export type OpportunityStatus =
  | "approaching"
  | "awaiting_confirmation"
  | "entry_touched"
  | "invalid"
  | "expired";

export const ACTIVE_STATUSES: OpportunityStatus[] = [
  "approaching",
  "awaiting_confirmation",
  "entry_touched",
];

export interface Quote {
  price: number;
  bid?: number;
  ask?: number;
  /** waktu harga menurut provider (detik UNIX) */
  time: number;
  dayOpen?: number;
  dayHigh?: number;
  dayLow?: number;
  /** provider menyatakan pasar buka/tutup, jika tersedia */
  marketOpen?: boolean;
}
