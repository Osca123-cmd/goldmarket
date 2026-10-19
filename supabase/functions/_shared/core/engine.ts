import type { AnalysisStatus, Candle, FeedStatus, OpportunityStatus, Timeframe } from "./types.ts";
import { ACTIVE_STATUSES } from "./types.ts";
import { EXPERIMENTAL_STRATEGIES, analysisTfs, type EngineConfig } from "./config.ts";
import { analyzeMarket, summarizeStatus, type MultiTfAnalysis } from "./analysis.ts";
import { assessQuality, closedAsOf, type QualityReport } from "./dataQuality.ts";
import { detectAll, type SetupCandidate } from "./strategies.ts";
import { dedupeBatch, dedupeCandidate, evaluateStatus, type StoredSetup } from "./setups.ts";
import { priceToPips } from "./instrument.ts";
import { deliveryBlock } from "./delivery.ts";
import { sessionAt } from "./sessions.ts";

export type NotificationKind = "new_setup" | "confirmed" | "entry_touched" | "invalid" | "expired" | "connection" | "signal_result" | "news_event";

export interface EngineNotification {
  kind: NotificationKind;
  dedupeKey: string;
  title: string;
  body: string;
  setupIdentity?: string;
  setupId?: string;
  severity: "info" | "success" | "warning" | "danger";
  /** skor & TF untuk filter minimum skor per pengguna */
  score?: number;
  timeframe?: Timeframe;
}

export interface EngineInput {
  nowSec: number;
  /** candle mentah per TF (boleh berisi bar yang masih berjalan) */
  rawCandles: Partial<Record<Timeframe, Candle[]>>;
  /** candle M5 untuk waktu sentuhan entry yang presisi */
  touchCandles?: Candle[];
  price: number | null;
  quoteTimeSec: number | null;
  spreadPips: number | null;
  /** spread asumsi bila provider tidak memberi bid/ask */
  assumedSpreadPips: number;
  feedStatus: FeedStatus;
  previousFeedStatus: FeedStatus | null;
  existing: StoredSetup[];
  config: EngineConfig;
  /** rilis FOMC/NFP/CPI/PPI dalam jendela larangan (lihat newsBlackoutAt) — setup baru ditahan */
  newsBlackout?: { title: string; timeSec: number } | null;
}

export interface StatusChange {
  id: string;
  from: OpportunityStatus;
  to: OpportunityStatus;
  reason: string;
  confirmedAt: number | null;
  entryTouchedAt: number | null;
  events: string[];
  distancePips: number | null;
}

export interface EngineOutput {
  analysis: MultiTfAnalysis;
  status: AnalysisStatus;
  quality: QualityReport;
  created: SetupCandidate[];
  rejected: { identityKey: string; reason: string }[];
  changes: StatusChange[];
  notifications: EngineNotification[];
  session: string;
  /** alasan setup baru ditahan karena rilis news (null bila tidak) */
  blackoutReason: string | null;
}

/** Judul notifikasi siap-siap: "🟢 READY BUY XAUUSD — M15" / "🔴 READY SELL XAUUSD — H1". */
export function readyTitle(direction: "BUY" | "SELL", timeframe: string, suffix = "", strategy?: string): string {
  const exp = strategy && (EXPERIMENTAL_STRATEGIES as string[]).includes(strategy) ? " · 🧪 Eksperimen" : "";
  return `${direction === "BUY" ? "🟢" : "🔴"} READY ${direction} XAUUSD — ${timeframe}${exp}${suffix}`;
}

const FEED_LABEL: Record<FeedStatus, string> = {
  live: "Live",
  delayed: "Delayed",
  reconnecting: "Reconnecting",
  disconnected: "Disconnected",
  market_closed: "Market Closed",
  demo: "Demo",
};

/**
 * Satu siklus engine (tanpa I/O): validasi data → analisis → deteksi setup →
 * dedupe → evaluasi status setup lama → notifikasi.
 */
export function runEngineCycle(i: EngineInput): EngineOutput {
  const cfg = i.config;
  const tfs: Timeframe[] = analysisTfs(cfg);
  const closed: Partial<Record<Timeframe, Candle[]>> = {};
  for (const tf of Object.keys(i.rawCandles) as Timeframe[]) closed[tf] = closedAsOf(i.rawCandles[tf] ?? [], tf, i.nowSec);

  const spread = i.spreadPips ?? i.assumedSpreadPips;
  const quality = assessQuality({
    nowSec: i.nowSec,
    quoteTimeSec: i.quoteTimeSec,
    status: i.feedStatus,
    candles: closed,
    requiredTfs: tfs,
    minBars: 60,
    spreadPips: i.spreadPips,
    thresholds: cfg.thresholds,
  });
  const analysis = analyzeMarket({ nowSec: i.nowSec, candles: closed }, tfs, cfg.biasTfs);

  const notifications: EngineNotification[] = [];
  const created: SetupCandidate[] = [];
  const blackoutReason =
    i.newsBlackout && cfg.newsBlackoutMin > 0
      ? `Rilis ${i.newsBlackout.title} ${i.newsBlackout.timeSec > i.nowSec ? `dalam ${Math.max(1, Math.round((i.newsBlackout.timeSec - i.nowSec) / 60))} menit` : "baru saja"} — setup baru ditahan ±${cfg.newsBlackoutMin} menit di sekitar rilis.`
      : null;
  const rejected: EngineOutput["rejected"] = [];

  // Sinyal baru HANYA bila data lolos validasi (tidak basi, tidak ada candle hilang, koneksi sehat).
  if (quality.ok && i.price != null && i.feedStatus !== "market_closed") {
    const cands = dedupeBatch(
      detectAll({ analysis, candles: closed, price: i.price, spreadPips: spread, nowSec: i.nowSec, dataTime: i.quoteTimeSec ?? i.nowSec, config: cfg }),
      cfg,
    );
    const pool = [...i.existing];
    for (const c of cands) {
      if (blackoutReason) {
        rejected.push({ identityKey: c.identityKey, reason: blackoutReason });
        continue;
      }
      const v = dedupeCandidate(c, pool, cfg);
      if (!v.ok) {
        rejected.push({ identityKey: c.identityKey, reason: v.reason });
        continue;
      }
      // aturan pengiriman (1 sinyal sekaligus, jendela jam): kandidat terbaik lebih dulu (dedupeBatch urut skor)
      const held = c.eligible ? deliveryBlock(c, pool, cfg, i.nowSec) : null;
      if (held) {
        rejected.push({ identityKey: c.identityKey, reason: held });
        continue;
      }
      created.push(c);
      pool.push({
        id: c.identityKey,
        identity_key: c.identityKey,
        strategy: c.strategy,
        direction: c.direction,
        timeframe: c.timeframe,
        confirm_tf: c.confirmTf,
        entry_type: c.entryType,
        entry_price: c.entry,
        entry_low: c.entryLow,
        entry_high: c.entryHigh,
        invalidation: c.invalidation,
        sl: c.sl,
        created_at_sec: c.createdAt,
        expires_at_sec: c.expiresAt,
        status: "approaching",
        eligible: c.eligible,
        confirmed_at_sec: null,
        entry_touched_at_sec: null,
      });
      if (c.eligible) {
        notifications.push({
          kind: "new_setup",
          dedupeKey: `new:${c.identityKey}`,
          title: readyTitle(c.direction, c.timeframe, "", c.strategy),
          body: `Zona ${c.entryLow.toFixed(2)}–${c.entryHigh.toFixed(2)} · entry ${c.entryType} ${c.entry.toFixed(2)} · SL ${c.sl.toFixed(2)} · TP1 ${c.tp1.toFixed(2)} · TP2 ${c.tp2.toFixed(2)} · TP3 ${c.tp3.toFixed(2)} · skor ${c.score.total}/100. Siapkan rencana; tunggu harga masuk zona & konfirmasi.`,
          setupIdentity: c.identityKey,
          severity: "info",
          score: c.score.total,
          timeframe: c.timeframe,
        });
      }
    }
  }

  // Evaluasi status setup aktif yang sudah tersimpan.
  const changes: StatusChange[] = [];
  for (const s of i.existing) {
    if (!ACTIVE_STATUSES.includes(s.status)) continue;
    const upd = evaluateStatus(s, {
      nowSec: i.nowSec,
      price: quality.quoteAgeSec <= cfg.thresholds.signalMaxAgeSec ? i.price : null,
      confirmCandles: i.rawCandles[s.confirm_tf] ?? [],
      touchCandles: i.touchCandles,
      mainBias: analysis.mainBias,
      dataOk: quality.quoteAgeSec <= cfg.thresholds.signalMaxAgeSec && i.feedStatus !== "disconnected",
    });
    const dist = i.price != null ? priceToPips(Math.abs(i.price - s.entry_price), cfg.spec) : null;
    if (upd.status !== s.status || upd.confirmedAt !== s.confirmed_at_sec || upd.events.length > 0) {
      changes.push({ id: s.id, from: s.status, to: upd.status, reason: upd.reason, confirmedAt: upd.confirmedAt, entryTouchedAt: upd.entryTouchedAt, events: upd.events, distancePips: dist });
    } else {
      changes.push({ id: s.id, from: s.status, to: s.status, reason: "", confirmedAt: s.confirmed_at_sec, entryTouchedAt: s.entry_touched_at_sec, events: [], distancePips: dist });
    }
    if (!s.eligible) continue;
    for (const ev of upd.events) {
      if (ev === "confirmed")
        notifications.push({ kind: "confirmed", dedupeKey: `confirmed:${s.id}`, title: `✅ KONFIRMASI ${s.direction} XAUUSD — ${s.timeframe}`, body: `Candle ${s.confirm_tf} tertutup mengonfirmasi area ${s.entry_low.toFixed(2)}–${s.entry_high.toFixed(2)}.`, setupId: s.id, severity: "success", timeframe: s.timeframe });
      if (ev === "entry_touched")
        notifications.push({ kind: "entry_touched", dedupeKey: `touched:${s.id}`, title: `🎯 ZONA ENTRY TERSENTUH — ${s.direction} XAUUSD ${s.timeframe}`, body: `Harga feed menyentuh ${s.entry_price.toFixed(2)}. Ini bukan konfirmasi bahwa Anda membuka posisi.`, setupId: s.id, severity: "info", timeframe: s.timeframe });
      if (ev === "invalid")
        notifications.push({ kind: "invalid", dedupeKey: `invalid:${s.id}`, title: `❌ SETUP BATAL (invalid) — ${s.direction} XAUUSD ${s.timeframe}`, body: upd.reason, setupId: s.id, severity: "danger", timeframe: s.timeframe });
      if (ev === "expired")
        notifications.push({ kind: "expired", dedupeKey: `expired:${s.id}`, title: `⌛ SETUP KEDALUWARSA — ${s.direction} XAUUSD ${s.timeframe}`, body: upd.reason, setupId: s.id, severity: "warning", timeframe: s.timeframe });
    }
  }

  // Gangguan koneksi: hanya saat transisi status (dedupe per jam).
  const bad: FeedStatus[] = ["reconnecting", "disconnected"];
  if (i.previousFeedStatus && i.previousFeedStatus !== i.feedStatus && (bad.includes(i.feedStatus) || bad.includes(i.previousFeedStatus))) {
    const hour = Math.floor(i.nowSec / 3600);
    notifications.push({
      kind: "connection",
      dedupeKey: `conn:${i.feedStatus}:${hour}`,
      title: `Status feed: ${FEED_LABEL[i.feedStatus]}`,
      body: bad.includes(i.feedStatus) ? "Koneksi data bermasalah. Sinyal baru dihentikan sampai data kembali valid." : "Koneksi data pulih.",
      severity: bad.includes(i.feedStatus) ? "danger" : "success",
    });
  }

  const activeAfter = changes.filter((c) => ACTIVE_STATUSES.includes(c.to));
  const hasAwaiting = activeAfter.some((c) => c.to === "awaiting_confirmation") || created.some((c) => c.eligible && !c.confirmed);
  return {
    analysis,
    status: summarizeStatus(analysis, quality.ok, hasAwaiting),
    quality,
    created,
    rejected,
    blackoutReason,
    changes,
    notifications,
    session: sessionAt(i.nowSec * 1000),
  };
}
