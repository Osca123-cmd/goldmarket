"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import type { Candle, FeedStatus, StrategyId, Timeframe } from "@/core/types";
import { LIVE_MAX_AGE_SEC, backoffSeconds } from "@/core/dataQuality";

export interface Snapshot {
  source: string;
  source_label: string;
  proxy_note: string | null;
  is_demo: boolean;
  supports_bid_ask: boolean;
  price: number | null;
  bid: number | null;
  ask: number | null;
  spread_pips: number | null;
  day_open: number | null;
  day_high: number | null;
  day_low: number | null;
  day_change: number | null;
  day_change_pct: number | null;
  quote_time: string | null;
  fetched_at: string | null;
  feed_status: FeedStatus;
  market_open: boolean | null;
  consecutive_failures: number;
  next_retry_at: string | null;
  last_error: string | null;
  updated_at: string;
}

export interface SetupRow {
  id: string;
  identity_key: string;
  created_at: string;
  expires_at: string;
  updated_at: string;
  direction: "BUY" | "SELL";
  strategy: StrategyId;
  timeframe: Timeframe;
  confirm_tf: Timeframe;
  entry_type: "market" | "limit" | "stop";
  entry_price: number;
  entry_low: number;
  entry_high: number;
  invalidation: number | null;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  sl_pips: number;
  pip_size: number;
  rr: { tp1: number; tp2: number; tp3: number; tp2AfterCost: number };
  spread_pips: number | null;
  score: number;
  score_breakdown: { total: number; components: { key: string; label: string; points: number; max: number; note: string }[] };
  gates: { key: string; label: string; pass: boolean; note: string }[];
  eligible: boolean;
  reasons: string[];
  status: "approaching" | "awaiting_confirmation" | "entry_touched" | "invalid" | "expired";
  status_reason: string | null;
  confirmed_at: string | null;
  confirmation: string | null;
  entry_touched_at: string | null;
  last_price: number | null;
  distance_pips: number | null;
  session: string | null;
  data_source: string;
  data_time: string;
  outcome: "open" | "win" | "loss" | "timeout" | null;
  outcome_tp: number | null;
  outcome_pips: number | null;
  outcome_at: string | null;
  outcome_note: string | null;
  outcome_ambiguous: boolean;
  /** dikecualikan pengguna dari statistik (tetap terlihat di riwayat beserta alasan) */
  excluded?: boolean;
  excluded_reason?: string | null;
}

export interface AnalysisRow {
  id: number;
  created_at: string;
  source: string;
  status: "bullish" | "bearish" | "ranging" | "awaiting_confirmation" | "no_valid_setup";
  main_bias: "bullish" | "bearish" | "ranging";
  strong_bias: boolean;
  quality_ok: boolean;
  quality_reasons: string[];
  reasons: string[];
  timeframes: Record<string, { bias: string; structure: string; close: number; ema20: number; ema50: number; ema200: number | null; rsi: number; atr: number; slope: number; bars: number; last_time: string }>;
  levels: { price: number; touches: number; kind: "support" | "resistance"; tf: string }[];
  session: string | null;
  price: number | null;
  data_time: string | null;
}

export interface NotificationRow {
  id: string;
  created_at: string;
  kind: string;
  title: string;
  body: string;
  severity: "info" | "success" | "warning" | "danger";
  setup_id: string | null;
  score: number | null;
  timeframe: string | null;
}

export type ChannelState = "connecting" | "websocket" | "polling" | "offline";

/**
 * Langganan tabel lewat Supabase Realtime (WebSocket) dengan fallback polling
 * terkontrol + reconnect exponential backoff dan batas retry.
 */
function useLive<T>(key: string, table: string, fetcher: () => Promise<T>, pollMs = 15000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState<ChannelState>("connecting");
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;

  const refresh = useCallback(async () => {
    try {
      const d = await fetchRef.current();
      setData(d);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    let ch: RealtimeChannel | null = null;
    let retries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const MAX_RETRIES = 6;

    const startPolling = (ms: number) => {
      if (poll) clearInterval(poll);
      poll = setInterval(refresh, ms);
    };

    const connect = () => {
      if (!alive) return;
      const thisCh: RealtimeChannel = supabase()
        .channel(`live:${key}:${Math.random().toString(36).slice(2)}`)
        .on("postgres_changes", { event: "*", schema: "public", table }, () => {
          // gabungkan beberapa event berdekatan menjadi satu fetch (deduplikasi)
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(refresh, 250);
        });
      ch = thisCh;
      thisCh.subscribe((status) => {
        // abaikan callback dari channel lama (removeChannel memicu CLOSED secara re-entrant)
        if (!alive || ch !== thisCh) return;
        if (status === "SUBSCRIBED") {
          retries = 0;
          setChannel("websocket");
          startPolling(60000); // jaring pengaman
          void refresh();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          ch = null;
          retries += 1;
          setChannel(retries > MAX_RETRIES ? "offline" : "polling");
          startPolling(retries > MAX_RETRIES ? 60000 : pollMs);
          // ditunda: memanggil removeChannel di dalam callback status memicu rekursi di realtime-js
          setTimeout(() => void supabase().removeChannel(thisCh), 0);
          if (retries <= MAX_RETRIES) retryTimer = setTimeout(connect, backoffSeconds(retries, 2, 120) * 1000);
        }
      });
    };

    void refresh();
    startPolling(pollMs);
    connect();
    return () => {
      alive = false;
      if (poll) clearInterval(poll);
      if (retryTimer) clearTimeout(retryTimer);
      if (debounce) clearTimeout(debounce);
      if (ch) void supabase().removeChannel(ch);
    };
  }, [key, table, pollMs, refresh]);

  return { data, error, channel, refresh };
}

export function useSnapshot() {
  return useLive<Snapshot | null>("snapshot", "market_snapshot", async () => {
    const { data, error } = await supabase().from("market_snapshot").select("*").eq("id", "current").maybeSingle();
    if (error) throw error;
    return data as Snapshot | null;
  });
}

export function useAnalysis() {
  return useLive<AnalysisRow | null>("analysis", "analysis_snapshots", async () => {
    const { data, error } = await supabase().from("analysis_snapshots").select("*").order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    return data as AnalysisRow | null;
  }, 30000);
}

export function useSetups(days = 3) {
  return useLive<SetupRow[]>(`setups:${days}`, "setups", async () => {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const { data, error } = await supabase()
      .from("setups")
      .select("*")
      .or(`status.in.(approaching,awaiting_confirmation),and(status.eq.entry_touched,or(outcome.is.null,outcome.eq.open)),created_at.gte.${since}`)
      .order("created_at", { ascending: false })
      .limit(300);
    if (error) throw error;
    return (data ?? []) as SetupRow[];
  }, 30000);
}

/** Sinyal masih aktif: belum tersentuh, atau tersentuh tetapi belum ada TP. Setelah TP1 (SL di BE) setup tidak berlaku untuk entry baru. */
export function isActiveSignal(s: Pick<SetupRow, "status" | "outcome" | "outcome_tp">): boolean {
  if (s.status === "approaching" || s.status === "awaiting_confirmation") return true;
  return s.status === "entry_touched" && (s.outcome == null || s.outcome === "open") && !(s.outcome_tp ?? 0);
}

/** Sinyal berjalan: entry sudah tersentuh, hasil TP/SL belum final — selalu ditampilkan (sudah dinotifikasi). */
export function isRunningSignal(s: Pick<SetupRow, "status" | "outcome">): boolean {
  return s.status === "entry_touched" && (s.outcome == null || s.outcome === "open");
}

/** Pips mengambang posisi sinyal pada harga sekarang (positif = untung searah arah sinyal). */
export function floatingPips(direction: "BUY" | "SELL", entry: number, price: number, pipSize: number): number {
  return ((direction === "BUY" ? 1 : -1) * (price - entry)) / pipSize;
}

/** Riwayat sinyal: setup yang entry-nya tersentuh menurut feed beserta hasilnya. */
export function useSignalHistory(limit = 100) {
  return useLive<SetupRow[]>(`history:${limit}`, "setups", async () => {
    const { data, error } = await supabase()
      .from("setups")
      .select("*")
      .not("outcome", "is", null)
      .order("entry_touched_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data ?? []) as SetupRow[];
  }, 60000);
}

export function useNotifications() {
  return useLive<NotificationRow[]>("notifications", "notifications", async () => {
    const { data, error } = await supabase().from("notifications").select("*").order("created_at", { ascending: false }).limit(50);
    if (error) throw error;
    return (data ?? []) as NotificationRow[];
  }, 30000);
}

export type KeyTopic = "FOMC" | "NFP" | "CPI" | "PPI";

export interface NewsRow {
  id: string;
  topic: KeyTopic | null;
  title: string;
  link: string;
  source: string;
  published_at: string | null;
  snippet: string;
  label: "bullish" | "bearish" | "neutral";
  /** kekuatan bias: rendah = lemah, sedang = sedang, tinggi = kuat */
  confidence: "rendah" | "sedang" | "tinggi";
  conflict: boolean;
  rule_ids: string[];
  reasons: string[];
  explanation: string;
  created_at: string;
}

export interface EconEventRow {
  event_key: string;
  topic: KeyTopic | null;
  title: string;
  country: string;
  impact: "High" | "Medium" | "Low" | "Holiday";
  time_at: string;
  forecast: string | null;
  previous: string | null;
  fetched_at: string;
}

export function useNews(limit = 60) {
  return useLive<NewsRow[]>(`news:${limit}`, "news_items", async () => {
    const { data, error } = await supabase().from("news_items").select("*").not("topic", "is", null).order("published_at", { ascending: false, nullsFirst: false }).limit(limit);
    if (error) throw error;
    return (data ?? []) as NewsRow[];
  }, 120000);
}

export interface AiAnalysisRow {
  id: string;
  created_at: string;
  image_path: string;
  tf: "M5" | "M15" | "M30" | "H1" | "H4";
  note: string;
  provider: string | null;
  model: string | null;
  price: number | null;
  bias: string | null;
  summary: string | null;
  structure: string[];
  notes: string[];
  status: "failed" | "no_setup" | "rejected" | "pending" | "entry_touched" | "expired" | "invalid" | "closed";
  reject_reason: string | null;
  direction: "BUY" | "SELL" | null;
  entry_type: "market" | "limit" | null;
  entry: number | null;
  sl: number | null;
  tp: number | null;
  rr: number | null;
  sl_pips: number | null;
  tp_pips: number | null;
  target_reason: string | null;
  invalidation: string | null;
  reasons: string[];
  expires_at: string | null;
  entry_touched_at: string | null;
  outcome: "open" | "win" | "loss" | "timeout" | null;
  outcome_pips: number | null;
  outcome_r: number | null;
  outcome_at: string | null;
  outcome_note: string | null;
}

/** Riwayat Analisa AI Gambar milik pengguna (RLS), terbaru dulu. */
export function useAiAnalyses(limit = 100) {
  return useLive<AiAnalysisRow[]>(`ai:${limit}`, "ai_analyses", async () => {
    const { data, error } = await supabase().from("ai_analyses").select("*").order("created_at", { ascending: false }).limit(limit);
    if (error) throw error;
    return (data ?? []) as AiAnalysisRow[];
  }, 60000);
}

/** Event kalender ekonomi dari 1 hari lalu ke depan (urut waktu). */
export function useEconEvents() {
  return useLive<EconEventRow[]>("econ", "econ_events", async () => {
    const since = new Date(Date.now() - 86400000).toISOString();
    const { data, error } = await supabase().from("econ_events").select("*").not("topic", "is", null).gte("time_at", since).order("time_at").limit(200);
    if (error) throw error;
    return (data ?? []) as EconEventRow[];
  }, 300000);
}

export async function fetchCandles(source: string, tf: Timeframe, limit = 500): Promise<Candle[]> {
  const { data, error } = await supabase()
    .from("market_candles")
    .select("ts,open,high,low,close,volume")
    .eq("source", source)
    .eq("timeframe", tf)
    .order("ts", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? [])
    .map((r) => ({ time: Math.floor(Date.parse(r.ts) / 1000), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume ?? undefined }))
    .reverse();
}

/**
 * Status efektif di browser: tidak pernah lebih optimis dari data.
 * Harga lebih tua dari LIVE_MAX_AGE_SEC → Delayed; snapshot tidak diperbarui > 3 menit → Disconnected.
 */
export function effectiveStatus(s: Snapshot | null, now = Date.now()): FeedStatus {
  if (!s) return "disconnected";
  if (s.is_demo) return "demo";
  if (now - Date.parse(s.updated_at) > 180_000) return "disconnected";
  if (s.feed_status !== "live") return s.feed_status;
  const age = s.quote_time ? (now - Date.parse(s.quote_time)) / 1000 : Infinity;
  return age <= LIVE_MAX_AGE_SEC ? "live" : "delayed";
}

export const FEED_STATUS_LABEL: Record<FeedStatus, string> = {
  live: "Live",
  delayed: "Delayed",
  reconnecting: "Reconnecting",
  disconnected: "Disconnected",
  market_closed: "Market Closed",
  demo: "Demo",
};
