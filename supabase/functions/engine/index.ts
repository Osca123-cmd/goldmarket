// GOLDMARKET engine — Supabase Edge Function (Deno).
// Dipanggil pg_cron tiap menit (mode "tick"), tiap 15 menit (mode "news") dan harian (mode "backtest").
// Semua secret dibaca dari environment server; tidak ada yang dikirim ke browser.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";
import {
  ACTIVE_STATUSES,
  TF_SECONDS,
  ProviderError,
  backoffSeconds,
  createProvider,
  analysisTfs,
  usesTwelveDataCandles,
  dedupeCandles,
  marketHoursOnly,
  candleBehind,
  deriveFeedStatus,
  isMarketOpenBySchedule,
  mergeConfig,
  priceToPips,
  runBacktestTrades,
  probabilityReports,
  summarizeTrades,
  nextChunk,
  expectedChunks,
  CHUNK_SEC,
  type BacktestTrade,
  runEngineCycle,
  DEFAULT_BT,
  evaluateOutcome,
  readyTitle,
  classifyGoldImpact,
  dedupeNews,
  eventsInAlertWindow,
  explainImpact,
  maxSimilarity,
  newsEventBody,
  newsEventTitle,
  newsKey,
  parseFfCalendar,
  parseRss,
  FED_POLICY,
  calendarTopic,
  newsTopic,
  newsBlackoutAt,
  type Candle,
  type EngineConfig,
  type FeedStatus,
  type MarketProvider,
  type Quote,
  type SetupCandidate,
  type StoredSetup,
  type Timeframe,
} from "../_shared/core/index.ts";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const MAX_RETRIES = Number(env("MAX_RETRIES", "6"));
const QUOTE_INTERVAL_SEC = Number(env("QUOTE_INTERVAL_SEC", "60"));
const ASSUMED_SPREAD_PIPS = Number(env("ASSUMED_SPREAD_PIPS", "3"));
const STORED_TFS: Timeframe[] = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"];
const SIGNAL_MAX_HOLD_SEC = Number(env("SIGNAL_MAX_HOLD_HOURS", "24")) * 3600;
const APP_URL = env("APP_URL", "https://osca123-cmd.github.io/goldmarket/");
const NEWS_BELL_MIN = 30; // notifikasi in-app (lonceng) untuk news besar, menit sebelum rilis

type Db = SupabaseClient;
const iso = (sec: number) => new Date(sec * 1000).toISOString();
const sec = (s: string | null | undefined) => (s ? Math.floor(Date.parse(s) / 1000) : null);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function safeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** Secret pemanggil dicek terhadap env ENGINE_SECRET bila ada, jika tidak terhadap Supabase Vault (`engine_secret`). */
async function authorized(db: Db, given: string): Promise<boolean> {
  if (!given) return false;
  const fromEnv = env("ENGINE_SECRET");
  if (fromEnv) return safeEqual(given, fromEnv);
  const { data, error } = await db.rpc("engine_secret_ok", { p_secret: given });
  return !error && data === true;
}

/** Provider: env MARKET_PROVIDER > engine_state.config.provider > td_hybrid (bila key Twelve Data ada) > spot_hybrid. */
function providerId(stateConfig: Record<string, unknown> | null | undefined): string {
  return env("MARKET_PROVIDER") || (stateConfig?.provider as string | undefined) || (tdKey ? "td_hybrid" : "spot_hybrid");
}

/** API key Twelve Data: secret Edge Function TWELVEDATA_API_KEY, atau Vault 'twelvedata_api_key'. Diisi per request. */
let tdKey = "";
async function loadTdKey(db: Db): Promise<string> {
  const fromEnv = env("TWELVEDATA_API_KEY");
  if (fromEnv) return fromEnv;
  const { data, error } = await db.rpc("twelvedata_key_get");
  return !error && typeof data === "string" ? data.trim() : "";
}

/** Pesan error aman untuk log/DB: tanpa API key. */
function scrub(msg: string): string {
  const key = tdKey;
  let m = msg.slice(0, 300);
  if (key) m = m.split(key).join("***");
  return m.replace(/apikey=[^&\s]+/gi, "apikey=***");
}

// ---------------------------------------------------------------------------
async function loadCandles(db: Db, source: string, tf: Timeframe, limit: number): Promise<Candle[]> {
  const out: Candle[] = [];
  const page = 1000;
  for (let from = 0; from < limit; from += page) {
    const { data, error } = await db
      .from("market_candles")
      .select("ts,open,high,low,close,volume")
      .eq("source", source)
      .eq("timeframe", tf)
      .order("ts", { ascending: false })
      .range(from, Math.min(from + page, limit) - 1);
    if (error) throw new Error(`load candles ${tf}: ${error.message}`);
    out.push(...(data ?? []).map((r) => ({ time: sec(r.ts)!, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume ?? undefined })));
    if (!data || data.length < Math.min(page, limit - from)) break;
  }
  return dedupeCandles(out.reverse());
}

async function upsertCandles(db: Db, source: string, tf: Timeframe, candles: Candle[]) {
  const rows = dedupeCandles(candles).map((c) => ({
    source, timeframe: tf, ts: iso(c.time), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? null, updated_at: new Date().toISOString(),
  }));
  for (let i = 0; i < rows.length; i += 1000) {
    const { error } = await db.from("market_candles").upsert(rows.slice(i, i + 1000), { onConflict: "source,timeframe,ts" });
    if (error) throw new Error(`upsert candles ${tf}: ${error.message}`);
  }
  return rows.length;
}

function backfillSize(p: MarketProvider, tf: Timeframe): number {
  if (usesTwelveDataCandles(p.id)) return tf === "M1" ? 1000 : 5000;
  return { M1: 1000, M5: 5000, M15: 3000, M30: 2000, H1: 2000, H4: 1000, D1: 500 }[tf];
}

async function storedBarBehind(db: Db, source: string, tf: Timeframe, nowSec: number): Promise<boolean> {
  const { data } = await db.from("market_candles").select("ts").eq("source", source).eq("timeframe", tf).order("ts", { ascending: false }).limit(1).maybeSingle();
  return data ? candleBehind(sec(data.ts)!, tf, nowSec) : false;
}

/** Ambil candle yang jatuh tempo (bar baru tertutup) + backfill bertahap. Menghormati rate limit. */
async function refreshCandles(db: Db, p: MarketProvider, state: Record<string, unknown>, nowSec: number) {
  const lastFetch = (state.last_candle_fetch ?? {}) as Record<string, number>;
  const backfilled = (state.backfilled ?? {}) as Record<string, boolean>;
  const td = usesTwelveDataCandles(p.id);
  const tfs = STORED_TFS.filter((tf) => tf !== "M1" || !td || env("TD_INCLUDE_M1") === "true");
  let budget = td ? Number(env("TD_CREDITS_PER_RUN", "6")) : 20;
  let backfills = 0;
  const fetched: Record<string, number> = {};
  for (const tf of tfs) {
    if (budget <= 0) break;
    const step = TF_SECONDS[tf];
    const last = lastFetch[tf] ?? 0;
    const newBar = Math.floor(nowSec / step) > Math.floor(last / step);
    // Twelve Data (kredit terbatas): hanya saat bar baru, atau bila bar tersimpan tertinggal saat pasar buka
    // (mis. bar H4 yang diambil sebelum pasar buka Minggu), maks tiap 15 menit. Provider lain: bar berjalan tiap 5 menit.
    const behind = td && !newBar && backfilled[tf] && nowSec - last >= 900 && isMarketOpenBySchedule(nowSec * 1000) && (await storedBarBehind(db, p.id, tf, nowSec));
    const due = newBar || behind || (!td && nowSec - last >= Math.min(step, 300));
    if (!backfilled[tf]) {
      if (backfills >= 2) continue;
      const c = marketHoursOnly(await p.fetchCandles(tf, backfillSize(p, tf), nowSec), tf);
      fetched[tf] = await upsertCandles(db, p.id, tf, c);
      backfilled[tf] = true;
      lastFetch[tf] = nowSec;
      backfills++;
      budget--;
    } else if (due) {
      const c = marketHoursOnly(await p.fetchCandles(tf, 12, nowSec), tf);
      fetched[tf] = await upsertCandles(db, p.id, tf, c);
      lastFetch[tf] = nowSec;
      budget--;
    }
  }
  return { lastFetch, backfilled, fetched };
}

/**
 * Pembersihan sekali jalan: hapus candle tersimpan di luar jam pasar emas
 * (sebelum filter marketHoursOnly ada, bar PAXG akhir pekan ikut tersimpan).
 */
async function purgeOffHours(db: Db, source: string): Promise<number> {
  let removed = 0;
  for (const tf of STORED_TFS) {
    const stale: string[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db.from("market_candles").select("ts").eq("source", source).eq("timeframe", tf).order("ts").range(from, from + 999);
      if (error) throw new Error(`purge read ${tf}: ${error.message}`);
      for (const r of data ?? []) {
        const t = sec(r.ts)!;
        if (marketHoursOnly([{ time: t, open: 1, high: 1, low: 1, close: 1 }], tf).length === 0) stale.push(r.ts);
      }
      if (!data || data.length < 1000) break;
    }
    for (let i = 0; i < stale.length; i += 200) {
      const { error } = await db.from("market_candles").delete().eq("source", source).eq("timeframe", tf).in("ts", stale.slice(i, i + 200));
      if (error) throw new Error(`purge delete ${tf}: ${error.message}`);
    }
    removed += stale.length;
  }
  return removed;
}

function snapshotFromQuote(p: MarketProvider, q: Quote, cfg: EngineConfig) {
  const spread = q.bid != null && q.ask != null ? priceToPips(q.ask - q.bid, cfg.spec) : null;
  const change = q.dayOpen ? q.price - q.dayOpen : null;
  return {
    price: q.price,
    bid: q.bid ?? null,
    ask: q.ask ?? null,
    spread_pips: spread,
    day_open: q.dayOpen ?? null,
    day_high: q.dayHigh ?? null,
    day_low: q.dayLow ?? null,
    day_change: change,
    day_change_pct: change != null && q.dayOpen ? (change / q.dayOpen) * 100 : null,
    quote_time: iso(q.time),
  };
}

function toStored(r: Record<string, any>): StoredSetup {
  return {
    id: r.id,
    identity_key: r.identity_key,
    strategy: r.strategy,
    direction: r.direction,
    timeframe: r.timeframe,
    confirm_tf: r.confirm_tf,
    entry_type: r.entry_type,
    entry_price: r.entry_price,
    entry_low: r.entry_low,
    entry_high: r.entry_high,
    invalidation: r.invalidation ?? NaN,
    sl: r.sl,
    created_at_sec: sec(r.created_at)!,
    expires_at_sec: sec(r.expires_at)!,
    status: r.status,
    eligible: r.eligible,
    confirmed_at_sec: sec(r.confirmed_at),
    entry_touched_at_sec: sec(r.entry_touched_at),
  };
}

function setupRow(c: SetupCandidate, p: MarketProvider, price: number, session: string) {
  const inArea = price >= c.entryLow && price <= c.entryHigh;
  const status = !c.eligible ? "invalid" : c.entryType === "market" ? "entry_touched" : inArea && !c.confirmed ? "awaiting_confirmation" : "approaching";
  return {
    identity_key: c.identityKey,
    created_at: iso(c.createdAt),
    expires_at: iso(c.expiresAt),
    direction: c.direction,
    strategy: c.strategy,
    timeframe: c.timeframe,
    confirm_tf: c.confirmTf,
    entry_type: c.entryType,
    entry_price: c.entry,
    entry_low: c.entryLow,
    entry_high: c.entryHigh,
    invalidation: Number.isFinite(c.invalidation) ? c.invalidation : null,
    sl: c.sl,
    tp1: c.tp1,
    tp2: c.tp2,
    tp3: c.tp3,
    sl_pips: c.slPips,
    pip_size: 0,
    rr: c.rr,
    spread_pips: c.spreadPips,
    score: c.score.total,
    score_breakdown: c.score,
    gates: c.gates,
    eligible: c.eligible,
    reasons: c.reasons,
    status,
    status_reason: c.eligible
      ? status === "entry_touched" ? "Entry market pada harga saat konfirmasi (bukan berarti posisi dibuka)." : "Setup valid."
      : "Tidak layak: " + c.gates.filter((g) => !g.pass).map((g) => g.note).join(" "),
    confirmed_at: c.confirmed ? iso(c.createdAt) : null,
    confirmation: c.confirmation,
    entry_touched_at: status === "entry_touched" ? iso(c.createdAt) : null,
    last_price: price,
    distance_pips: null as number | null,
    session,
    data_source: p.label,
    data_time: iso(c.dataTime),
  };
}

// ---------------------------------------------------------------------------
async function tick(db: Db, cfg: EngineConfig, pid: string) {
  const nowSec = () => Math.floor(Date.now() / 1000);
  const t0 = nowSec();
  const [{ data: snap }, { data: stateRow }] = await Promise.all([
    db.from("market_snapshot").select("*").eq("id", "current").maybeSingle(),
    db.from("engine_state").select("*").eq("id", "engine").maybeSingle(),
  ]);
  const provider = createProvider(pid, { twelveDataKey: tdKey || undefined, basis: stateRow?.basis ?? null });
  const state: Record<string, any> = stateRow ?? { id: "engine", last_candle_fetch: {}, backfilled: {} };
  if (state.provider && state.provider !== provider.id) {
    state.backfilled = {};
    state.last_candle_fetch = {};
    state.candle_failures = 0;
    state.candle_retry_at = null;
  }
  const prevStatus = (snap?.feed_status ?? null) as FeedStatus | null;
  let failures = snap?.source === provider.id ? (snap?.consecutive_failures ?? 0) : 0;

  // exponential backoff antar run
  if (snap?.next_retry_at && Date.parse(snap.next_retry_at) > Date.now() && snap.source === provider.id) {
    return { skipped: "backoff", next_retry_at: snap.next_retry_at };
  }

  let quote: Quote | null = null;
  let lastError: string | null = null;
  let fetchInfo: Record<string, number> = {};
  try {
    const lastQuoteFetch = sec(snap?.fetched_at) ?? 0;
    if (provider.id !== "twelvedata" || t0 - lastQuoteFetch >= QUOTE_INTERVAL_SEC - 5 || snap?.source !== provider.id) {
      quote = await provider.fetchQuote(t0);
    }
    // sekali per provider: buang candle lama di luar jam pasar emas (lihat purgeOffHours)
    const maint = (state.maintenance ?? {}) as Record<string, unknown>;
    if (maint.offhours_purged_v1 !== provider.id) {
      fetchInfo.purged_offhours = await purgeOffHours(db, provider.id);
      state.maintenance = { ...maint, offhours_purged_v1: provider.id };
    }
    failures = 0;
  } catch (e) {
    failures += 1;
    lastError = scrub((e as Error).message);
    const rateLimited = e instanceof ProviderError && e.rateLimited;
    const wait = backoffSeconds(failures + (rateLimited ? 2 : 0), 15, 900);
    await db.from("market_snapshot").upsert({
      id: "current",
      source: provider.id,
      source_label: provider.label,
      proxy_note: provider.proxyNote,
      is_demo: provider.isDemo,
      supports_bid_ask: provider.supportsBidAsk,
      feed_status: provider.isDemo ? "demo" : failures >= MAX_RETRIES ? "disconnected" : "reconnecting",
      consecutive_failures: failures,
      next_retry_at: iso(t0 + wait),
      last_error: lastError,
      updated_at: new Date().toISOString(),
    });
  }

  // Candle terpisah dari quote: candle gagal tidak menghentikan harga. Sinyal baru tetap
  // tertahan oleh gate kualitas bila candle tertinggal (validateData). Backoff sendiri agar kredit tidak terbuang.
  let candleError: string | null = null;
  if (failures === 0) {
    const retryAt = sec(state.candle_retry_at) ?? 0;
    if (t0 < retryAt) {
      candleError = snap?.last_error?.startsWith("Candle") ? snap.last_error : `Candle ditunda hingga ${iso(retryAt)}.`;
    } else {
      try {
        const r = await refreshCandles(db, provider, state, t0);
        state.last_candle_fetch = r.lastFetch;
        state.backfilled = r.backfilled;
        fetchInfo = { ...fetchInfo, ...r.fetched };
        state.candle_failures = 0;
        state.candle_retry_at = null;
      } catch (e) {
        const n = (state.candle_failures ?? 0) + 1;
        const rateLimited = e instanceof ProviderError && e.rateLimited;
        state.candle_failures = n;
        state.candle_retry_at = iso(t0 + backoffSeconds(n + (rateLimited ? 2 : 0), 60, 1800));
        candleError = `Candle gagal diambil (percobaan ${n}): ${scrub((e as Error).message)}`;
        console.error("candles", candleError);
      }
    }
  }

  const quoteTime = quote ? quote.time : sec(snap?.quote_time);
  const marketOpen = quote?.marketOpen ?? isMarketOpenBySchedule(Date.now());
  const feedStatus = deriveFeedStatus({
    isDemo: provider.isDemo,
    marketOpen,
    lastSuccessSec: failures === 0 ? t0 : null,
    quoteTimeSec: quoteTime,
    nowSec: t0,
    consecutiveFailures: failures,
    maxRetries: MAX_RETRIES,
    liveMaxAgeSec: cfg.thresholds.liveMaxAgeSec,
  });

  const snapFields = quote ? snapshotFromQuote(provider, quote, cfg) : {};
  const price = quote?.price ?? snap?.price ?? null;
  // spread proxy (PAXG) bukan spread broker XAUUSD → tidak dipakai sebagai gate kualitas
  const spreadForEngine = provider.proxyNote && !provider.isDemo ? null : ((snapFields as { spread_pips?: number | null }).spread_pips ?? snap?.spread_pips ?? null);

  if (provider.basis != null) state.basis = provider.basis;
  const proxyNote = provider.proxyNote
    ? provider.proxyNote + (provider.basis != null && provider.id === "spot_hybrid" ? ` Basis saat ini ${provider.basis >= 0 ? "+" : ""}${provider.basis.toFixed(2)} USD.` : "") + (provider.lastQuoteNote ? " " + provider.lastQuoteNote : "")
    : null;
  if (failures === 0) {
    await db.from("market_snapshot").upsert({
      id: "current",
      source: provider.id,
      source_label: provider.label,
      proxy_note: proxyNote,
      is_demo: provider.isDemo,
      supports_bid_ask: provider.supportsBidAsk,
      ...snapFields,
      fetched_at: quote ? iso(t0) : snap?.fetched_at ?? null,
      feed_status: feedStatus,
      market_open: marketOpen,
      consecutive_failures: 0,
      next_retry_at: null,
      last_error: candleError,
      updated_at: new Date().toISOString(),
    });
  }

  // ---- analisis ----
  const raw: Partial<Record<Timeframe, Candle[]>> = {};
  for (const tf of analysisTfs(cfg)) raw[tf] = await loadCandles(db, provider.id, tf, 300);
  // M5 bukan TF analisis: dipakai untuk waktu sentuhan entry & pelacakan hasil (sumbu SL/TP di antara tick harga)
  const m5 = raw.M5 ?? (await loadCandles(db, provider.id, "M5", 300));
  const since = iso(t0 - 3 * 86400);
  const { data: existingRows } = await db
    .from("setups")
    .select("*")
    .or(`status.in.(approaching,awaiting_confirmation),created_at.gte.${since}`)
    .order("created_at", { ascending: false })
    .limit(500);
  const existing = (existingRows ?? []).map(toStored);

  // rilis FOMC/NFP/CPI/PPI ±N menit → setup baru ditahan (setup lama tetap dipantau)
  let blackout: { title: string; timeSec: number } | null = null;
  if (cfg.newsBlackoutMin > 0) {
    const w = cfg.newsBlackoutMin * 60;
    const { data: near } = await db.from("econ_events").select("title,time_at").not("topic", "is", null).gte("time_at", iso(t0 - w)).lte("time_at", iso(t0 + w)).limit(10);
    blackout = newsBlackoutAt((near ?? []).map((e) => ({ title: e.title, timeSec: sec(e.time_at)! })), t0, cfg.newsBlackoutMin);
  }

  const out = runEngineCycle({
    nowSec: t0,
    rawCandles: raw,
    touchCandles: m5,
    price,
    quoteTimeSec: quoteTime,
    spreadPips: spreadForEngine,
    assumedSpreadPips: ASSUMED_SPREAD_PIPS,
    feedStatus: provider.isDemo && failures === 0 ? (marketOpen ? "live" : "market_closed") : feedStatus,
    previousFeedStatus: prevStatus,
    existing,
    config: cfg,
    newsBlackout: blackout,
  });

  const tfSummary: Record<string, unknown> = {};
  for (const [tf, a] of Object.entries(out.analysis.tfs)) {
    if (!a) continue;
    tfSummary[tf] = {
      bias: a.bias, structure: a.structure.label, close: a.lastClose, ema20: a.ema20, ema50: a.ema50,
      ema200: Number.isFinite(a.ema200) ? a.ema200 : null, rsi: a.rsi, atr: a.atr, slope: a.ema50SlopeAtr, bars: a.bars, last_time: iso(a.lastTime),
    };
  }
  const levels = [
    ...(out.analysis.tfs.H1?.levels ?? []).map((l) => ({ ...l, tf: "H1" })),
    ...(out.analysis.tfs.M30?.levels ?? []).map((l) => ({ ...l, tf: "M30" })),
    ...(out.analysis.tfs.M15?.levels ?? []).map((l) => ({ ...l, tf: "M15" })),
  ].filter((l) => l.touches >= 2 && price != null && Math.abs(l.price - price) < 30);
  await db.from("analysis_snapshots").insert({
    source: provider.id,
    status: out.status,
    main_bias: out.analysis.mainBias,
    strong_bias: out.analysis.strongBias,
    quality_ok: out.quality.ok && !out.blackoutReason,
    quality_reasons: out.blackoutReason ? [...out.quality.reasons, out.blackoutReason] : out.quality.reasons,
    reasons: out.analysis.reasons,
    timeframes: tfSummary,
    levels,
    session: out.session,
    price,
    data_time: quoteTime ? iso(quoteTime) : null,
  });

  // ---- setup baru ----
  const idByIdentity = new Map<string, string>();
  for (const c of out.created) {
    const row = setupRow(c, provider, price ?? c.entry, out.session);
    row.pip_size = cfg.spec.pipSize;
    row.distance_pips = price != null ? priceToPips(Math.abs(price - c.entry), cfg.spec) : null;
    const { data, error } = await db.from("setups").insert(row).select("id").single();
    if (error) {
      if (!/duplicate key/.test(error.message)) console.error("insert setup", error.message);
      continue;
    }
    idByIdentity.set(c.identityKey, data.id);
    await db.from("setup_events").insert({ setup_id: data.id, to_status: row.status, event: "created", reason: row.status_reason, price });
  }

  // ---- perubahan status setup lama ----
  for (const ch of out.changes) {
    const patch: Record<string, unknown> = { distance_pips: ch.distancePips, last_price: price, updated_at: new Date().toISOString() };
    if (ch.to !== ch.from || ch.events.length) {
      patch.status = ch.to;
      if (ch.reason) patch.status_reason = ch.reason;
      patch.confirmed_at = ch.confirmedAt ? iso(ch.confirmedAt) : null;
      patch.entry_touched_at = ch.entryTouchedAt ? iso(ch.entryTouchedAt) : null;
    }
    await db.from("setups").update(patch).eq("id", ch.id);
    for (const ev of ch.events) {
      await db.from("setup_events").insert({ setup_id: ch.id, from_status: ch.from, to_status: ch.to, event: ev, reason: ch.reason, price });
    }
  }

  // ---- notifikasi (dedupe via dedupe_key unik) ----
  const notifRows = out.notifications.map((n) => ({
    kind: n.kind,
    dedupe_key: n.dedupeKey,
    title: n.title,
    body: n.body,
    severity: n.severity,
    setup_id: n.setupId ?? (n.setupIdentity ? idByIdentity.get(n.setupIdentity) ?? null : null),
    score: n.score ?? null,
    timeframe: n.timeframe ?? null,
  }));
  // ---- hasil sinyal menurut feed (Riwayat Sinyal; terpisah dari jurnal) ----
  const { data: tracking } = await db
    .from("setups")
    .select("id,direction,timeframe,strategy,entry_price,sl,tp1,tp2,tp3,entry_touched_at,score,outcome,outcome_tp")
    .eq("status", "entry_touched")
    .eq("eligible", true)
    .or("outcome.is.null,outcome.eq.open")
    .limit(100);
  for (const t of tracking ?? []) {
    const touched = sec(t.entry_touched_at);
    if (touched == null) continue;
    const r = evaluateOutcome({
      direction: t.direction,
      entry: t.entry_price,
      sl: t.sl,
      tps: [t.tp1, t.tp2, t.tp3],
      entryTouchedAtSec: touched,
      candles: m5,
      barSec: TF_SECONDS.M5,
      price: out.quality.quoteAgeSec <= cfg.thresholds.signalMaxAgeSec ? price : null,
      nowSec: t0,
      maxHoldSec: SIGNAL_MAX_HOLD_SEC,
      spec: cfg.spec,
      tpHitBefore: (t.outcome === "open" ? t.outcome_tp ?? 0 : 0) as 0 | 1 | 2 | 3,
    });
    if (r.outcome === (t.outcome ?? "") && r.tpHit === (t.outcome_tp ?? 0)) continue;
    await db.from("setups").update({ outcome: r.outcome, outcome_tp: r.tpHit, outcome_pips: r.pips, outcome_at: r.closedAtSec ? iso(r.closedAtSec) : null, outcome_note: r.note, outcome_ambiguous: r.ambiguous }).eq("id", t.id);
    if (r.outcome !== "open") {
      const label = r.outcome === "win" ? "WIN" : r.outcome === "loss" ? "LOSS" : "TIMEOUT";
      notifRows.push({
        kind: "signal_result",
        dedupe_key: `result:${t.id}`,
        title: `${label} ${t.direction} XAUUSD ${t.timeframe} ${r.pips != null ? (r.pips > 0 ? "+" : "") + r.pips.toFixed(1) + " pips" : ""}`.trim(),
        body: `${r.note} Hasil level sinyal menurut feed, bukan transaksi Anda.`,
        severity: r.outcome === "win" ? "success" : r.outcome === "loss" ? "danger" : "warning",
        setup_id: t.id,
        score: t.score,
        timeframe: t.timeframe,
      });
    }
  }

  // ---- news besar (kalender ekonomi): lonceng in-app 30 menit sebelumnya; push per pengguna di deliverPush ----
  let upcoming: UpcomingEvent[] = [];
  try {
    const { data: soon } = await db.from("econ_events").select("event_key,title,country,impact,time_at,forecast,previous").not("topic", "is", null).gt("time_at", iso(t0)).lte("time_at", iso(t0 + 240 * 60)).order("time_at").limit(20);
    // semua event FOMC/NFP/CPI/PPI dianggap "news besar" untuk peringatan
    upcoming = (soon ?? []).map((e) => ({ ...e, impact: "High", timeSec: sec(e.time_at)! }));
  } catch (e) {
    console.error("econ", (e as Error).message);
  }
  for (const e of eventsInAlertWindow(upcoming, t0, NEWS_BELL_MIN)) {
    notifRows.push({ kind: "news_event", dedupe_key: `news:${e.event_key}`, title: newsEventTitle(e, t0), body: newsEventBody(e), severity: "warning", setup_id: null, score: null, timeframe: null });
  }

  let inserted: typeof notifRows = [];
  if (notifRows.length) {
    const { data: ins } = await db.from("notifications").upsert(notifRows, { onConflict: "dedupe_key", ignoreDuplicates: true }).select("kind,title,body,severity,setup_id,score,timeframe");
    inserted = (ins ?? []) as typeof notifRows;
  }
  try {
    await deliverPush(db, inserted, price, cfg, t0, upcoming);
  } catch (e) {
    console.error("push", (e as Error).message);
  }

  state.provider = provider.id;
  state.last_run_at = new Date().toISOString();
  if (failures === 0) state.last_success_at = new Date().toISOString();
  state.updated_at = new Date().toISOString();
  await db.from("engine_state").upsert({ id: "engine", ...state });

  // ---- polling harga tambahan dalam menit yang sama (provider tanpa batas kredit ketat) ----
  if (provider.id !== "twelvedata" && failures === 0) {
    for (let i = 0; i < 3; i++) {
      await sleep(14_000);
      try {
        const q = await provider.fetchQuote(nowSec());
        await db.from("market_snapshot").update({
          ...snapshotFromQuote(provider, q, cfg),
          fetched_at: iso(nowSec()),
          feed_status: deriveFeedStatus({ isDemo: provider.isDemo, marketOpen: q.marketOpen ?? marketOpen, lastSuccessSec: nowSec(), quoteTimeSec: q.time, nowSec: nowSec(), consecutiveFailures: 0, maxRetries: MAX_RETRIES, liveMaxAgeSec: cfg.thresholds.liveMaxAgeSec }),
          market_open: q.marketOpen ?? marketOpen,
          updated_at: new Date().toISOString(),
        }).eq("id", "current");
      } catch (e) {
        console.error("subpoll", scrub((e as Error).message));
        break;
      }
    }
  }

  return {
    provider: provider.id,
    feedStatus,
    status: out.status,
    quality: out.quality.reasons,
    created: out.created.length,
    rejected: out.rejected.length,
    notifications: notifRows.length,
    fetched: fetchInfo,
    error: lastError,
    candle_error: candleError,
  };
}


// ---------------------------------------------------------------------------
// Web Push (HP/desktop, walau tab ditutup). Kunci privat VAPID hanya di Vault.
// ---------------------------------------------------------------------------
interface PushTarget { id: string; user_id: string; endpoint: string; p256dh: string; auth: string; failures: number }
interface PushPrefs { user_id: string; notify_kinds: Record<string, boolean>; min_score: Record<string, number>; near_entry_pips: number; pip_size: number; news_alert_minutes: number }
interface UpcomingEvent { event_key: string; title: string; country: string; impact: string; timeSec: number; forecast: string | null; previous: string | null }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WebPush = any;
let webpushMod: WebPush | null = null;
async function loadWebPush(): Promise<WebPush> {
  // impor dinamis: bila library push gagal dimuat, siklus analisis tetap berjalan
  if (!webpushMod) webpushMod = (await import("npm:web-push@3.6.7")).default;
  return webpushMod;
}

async function vapid(db: Db): Promise<{ public: string; private: string }> {
  const webpush = await loadWebPush();
  const { data } = await db.rpc("vapid_get");
  if (data?.public && data?.private) return data;
  const keys = webpush.generateVAPIDKeys();
  await db.rpc("vapid_set", { p_public: keys.publicKey, p_private: keys.privateKey });
  const { data: again } = await db.rpc("vapid_get");
  return again;
}

async function deliverPush(db: Db, fresh: { kind: string; title: string; body: string; setup_id: string | null; score: number | null; timeframe: string | null }[], price: number | null, cfg: EngineConfig, nowSec: number, upcoming: UpcomingEvent[] = []) {
  const { data: subs } = await db.from("push_subscriptions").select("id,user_id,endpoint,p256dh,auth,failures").limit(1000);
  if (!subs?.length) {
    await vapid(db); // pastikan kunci publik tersedia untuk klien
    return;
  }
  const users = [...new Set(subs.map((s) => s.user_id))];
  const { data: prefRows } = await db.from("user_settings").select("user_id,notify_kinds,min_score,near_entry_pips,pip_size,news_alert_minutes").in("user_id", users);
  const prefs = new Map((prefRows ?? []).map((p) => [p.user_id, { ...p, near_entry_pips: Number(p.near_entry_pips), pip_size: Number(p.pip_size), news_alert_minutes: Number(p.news_alert_minutes ?? 30) } as PushPrefs]));
  const keys = await vapid(db);
  const webpush = await loadWebPush();
  webpush.setVapidDetails("mailto:noreply@goldmarket.app", keys.public, keys.private);

  const queue: { userId: string; payload: Record<string, unknown> }[] = [];
  for (const uid of users) {
    const p = prefs.get(uid);
    const kinds = p?.notify_kinds ?? {};
    for (const n of fresh) {
      if (kinds[n.kind] === false || n.kind === "news_event") continue; // news_event: ambang menit per pengguna di bawah
      if (n.kind === "new_setup" && n.score != null && n.timeframe && n.score < (p?.min_score?.[n.timeframe] ?? 60)) continue;
      queue.push({ userId: uid, payload: { title: n.title, body: n.body, tag: `${n.kind}:${n.setup_id ?? ""}`, url: APP_URL + (n.setup_id ? "opportunities/" : "") } });
    }
  }

  // Uji push dari server (diminta pengguna lewat tombol; baris dihapus setelah diproses)
  const { data: tests } = await db.from("user_alerts").select("user_id,dedupe_key").like("dedupe_key", "pushtest:%").gte("created_at", iso(nowSec - 600));
  for (const t of tests ?? []) {
    queue.push({ userId: t.user_id, payload: { title: "GOLDMARKET — uji push server", body: "Push dari server berhasil sampai ke perangkat ini.", tag: "pushtest", url: APP_URL + "settings/" } });
    await db.from("user_alerts").delete().eq("user_id", t.user_id).eq("dedupe_key", t.dedupe_key);
  }

  // "Harga mendekati entry" per pengguna (ambang masing-masing), dedupe via user_alerts
  if (price != null) {
    const { data: near } = await db.from("setups").select("id,direction,timeframe,strategy,entry_price,entry_low,entry_high,sl,tp1,score").eq("status", "approaching").eq("eligible", true).limit(50);
    for (const uid of users) {
      const p = prefs.get(uid);
      if (!p || p.notify_kinds?.near_entry === false) continue;
      for (const s of near ?? []) {
        if (s.score < (p.min_score?.[s.timeframe] ?? 60)) continue;
        const dist = Math.abs(price - s.entry_price) / (p.pip_size || cfg.spec.pipSize);
        if (dist > p.near_entry_pips) continue;
        const { error } = await db.from("user_alerts").insert({ user_id: uid, dedupe_key: `near:${s.id}` });
        if (error) continue; // sudah pernah diberi tahu
        queue.push({ userId: uid, payload: { title: readyTitle(s.direction, s.timeframe, ` · ${dist.toFixed(1)} pips lagi`, s.strategy), body: `Harga mendekati zona ${Number(s.entry_low).toFixed(2)}–${Number(s.entry_high).toFixed(2)} (entry ${Number(s.entry_price).toFixed(2)}, SL ${Number(s.sl).toFixed(2)}, TP1 ${Number(s.tp1).toFixed(2)}). Siapkan platform Anda; pemicu jarak, bukan jaminan.`, tag: `near:${s.id}`, url: APP_URL + "opportunities/" } });
      }
    }
  }

  // "News besar sebentar lagi" per pengguna (ambang menit masing-masing), sekali per event
  if (upcoming.length) {
    for (const uid of users) {
      const p = prefs.get(uid);
      if (p?.notify_kinds?.news_event === false) continue;
      for (const e of eventsInAlertWindow(upcoming, nowSec, p?.news_alert_minutes ?? NEWS_BELL_MIN)) {
        const { error } = await db.from("user_alerts").insert({ user_id: uid, dedupe_key: `news:${e.event_key}`.slice(0, 200) });
        if (error) continue;
        queue.push({ userId: uid, payload: { title: newsEventTitle(e, nowSec), body: newsEventBody(e), tag: `news:${e.event_key}`, url: APP_URL + "news/" } });
      }
    }
  }

  for (const q of queue.slice(0, 200)) {
    for (const sub of subs.filter((s) => s.user_id === q.userId) as PushTarget[]) {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(q.payload), { TTL: 600, urgency: "high" });
        await db.from("push_subscriptions").update({ last_ok_at: iso(nowSec), failures: 0 }).eq("id", sub.id);
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410 || sub.failures >= 5) await db.from("push_subscriptions").delete().eq("id", sub.id);
        else await db.from("push_subscriptions").update({ failures: sub.failures + 1 }).eq("id", sub.id);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// News AI (gratis, tanpa API key): RSS berita emas + kalender ekonomi ForexFactory.
// Label dampak = aturan transparan (src/core/news.ts); relevansi = embedding gte-small
// bawaan Supabase Edge Runtime bila tersedia. Bukan sinyal, bukan probabilitas.
// ---------------------------------------------------------------------------
const NEWS_FEEDS: { id: string; label: string; url: string; only?: RegExp }[] = [
  { id: "gnews_fomc", label: "Google News", url: "https://news.google.com/rss/search?q=FOMC+OR+%22Fed+rate+decision%22+when:2d&hl=en-US&gl=US&ceid=US:en" },
  { id: "gnews_data", label: "Google News", url: "https://news.google.com/rss/search?q=%22nonfarm+payrolls%22+OR+%22US+CPI%22+OR+%22US+PPI%22+OR+%22producer+prices%22+when:2d&hl=en-US&gl=US&ceid=US:en" },
  { id: "inv_commodities", label: "Investing.com", url: "https://www.investing.com/rss/news_11.rss" },
  { id: "inv_economy", label: "Investing.com", url: "https://www.investing.com/rss/news_14.rss" },
  { id: "inv_forex", label: "Investing.com", url: "https://www.investing.com/rss/news_1.rss" },
  { id: "fed_press", label: "Federal Reserve", url: "https://www.federalreserve.gov/feeds/press_all.xml", only: FED_POLICY },
  { id: "cnbc_economy", label: "CNBC", url: "https://www.cnbc.com/id/20910258/device/rss/rss.html" },
  { id: "mw_top", label: "MarketWatch", url: "https://feeds.content.dowjones.io/public/rss/mw_topstories" },
];
const FF_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const NEWS_MAX_AGE_SEC = 48 * 3600;
const NEWS_MIN_RELEVANCE = Number(env("NEWS_MIN_RELEVANCE", "0"));
// Batas CPU Edge Function: embedding hanya untuk beberapa judul baru per putaran (label tetap berbasis aturan untuk semua)
const NEWS_EMBED_MAX = Number(env("NEWS_EMBED_MAX", "6"));
const RELEVANCE_PROTOTYPES = [
  "FOMC Federal Reserve interest rate decision",
  "US nonfarm payrolls jobs report",
  "US consumer price index CPI inflation report",
  "US producer price index PPI report",
];

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "user-agent": "GOLDMARKET/1.0 (+news reader)", accept: "application/rss+xml, application/json, text/xml, */*" }, signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Embedder = { run: (text: string, opts: Record<string, unknown>) => Promise<any> };
let embedder: Embedder | null | undefined;
let protoCache: number[][] | null = null;
function getEmbedder(): Embedder | null {
  if (embedder !== undefined) return embedder;
  try {
    // deno-lint-ignore no-explicit-any
    const ai = (globalThis as any).Supabase?.ai;
    embedder = ai ? new ai.Session("gte-small") : null;
  } catch {
    embedder = null;
  }
  return embedder ?? null;
}
async function embed(text: string): Promise<number[] | null> {
  const e = getEmbedder();
  if (!e) return null;
  try {
    const v = await e.run(text, { mean_pool: true, normalize: true });
    return Array.isArray(v) || ArrayBuffer.isView(v) ? Array.from(v as ArrayLike<number>) : null;
  } catch {
    return null;
  }
}

async function news(db: Db) {
  const t0 = Math.floor(Date.now() / 1000);
  const feeds: Record<string, number | string> = {};

  // ---- retensi (lebih dulu, agar berita yang dibuang tidak dianggap "sudah ada"): berita > 7 hari, event > 14 hari, rilis Fed non-kebijakan ----
  await db.from("news_items").delete().lt("created_at", iso(t0 - 7 * 86400));
  await db.from("econ_events").delete().lt("time_at", iso(t0 - 14 * 86400));
  await db.from("news_items").delete().eq("feed", "fed_press").not("title", "imatch", FED_POLICY.source.replace(/\\b/g, "\\y"));
  await db.from("news_items").delete().is("topic", null); // di luar FOMC/NFP/CPI/PPI
  await db.from("econ_events").delete().is("topic", null);

  // event kalender yang kini di luar fokus (mis. pidato anggota FOMC)
  const { data: evRows } = await db.from("econ_events").select("event_key,title");
  const offTopic = (evRows ?? []).filter((e) => !calendarTopic(e.title)).map((e) => e.event_key);
  if (offTopic.length) await db.from("econ_events").delete().in("event_key", offTopic);

  // ---- berita ----
  const settled = await Promise.allSettled(NEWS_FEEDS.map(async (f) => ({ f, items: parseRss(await fetchText(f.url), f.label) })));
  const all: { item: ReturnType<typeof parseRss>[number]; feed: string }[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") {
      feeds[NEWS_FEEDS[i].id] = r.value.items.length;
      for (const item of r.value.items) if (!r.value.f.only || r.value.f.only.test(item.title)) all.push({ item, feed: r.value.f.id });
    } else feeds[NEWS_FEEDS[i].id] = scrub(String((r.reason as Error)?.message ?? r.reason));
  });
  const feedOf = new Map(all.map((a) => [newsKey(a.item.title), a.feed]));
  // hanya berita FOMC / NFP / CPI / PPI
  const fresh = dedupeNews(all.map((a) => a.item)).filter((it) => newsTopic(it.title, it.snippet) && (it.publishedAt == null || t0 - it.publishedAt <= NEWS_MAX_AGE_SEC)).slice(0, 60);

  // hanya proses judul yang belum tersimpan
  const keys = fresh.map((it) => newsKey(it.title));
  const { data: existing } = keys.length ? await db.from("news_items").select("dedupe_key").in("dedupe_key", keys) : { data: [] };
  const known = new Set((existing ?? []).map((r) => r.dedupe_key));
  const todo = fresh.filter((it) => !known.has(newsKey(it.title)));

  let embedded = 0;
  const rows = [];
  for (const it of todo) {
    let relevance: number | null = null;
    if (embedded < NEWS_EMBED_MAX && protoCache === null && getEmbedder()) {
      const ps = [];
      for (const t of RELEVANCE_PROTOTYPES) ps.push(await embed(t));
      protoCache = ps.filter((v): v is number[] => !!v);
    }
    const protos = protoCache ?? [];
    if (embedded < NEWS_EMBED_MAX && protos.length) {
      const v = await embed(`${it.title}. ${it.snippet}`);
      if (v) {
        relevance = Math.round(maxSimilarity(v, protos) * 1000) / 1000;
        embedded++;
      }
    }
    if (relevance != null && relevance < NEWS_MIN_RELEVANCE) continue;
    const r = classifyGoldImpact(it.title, it.snippet);
    rows.push({
      dedupe_key: newsKey(it.title),
      topic: newsTopic(it.title, it.snippet),
      title: it.title,
      link: it.link,
      source: it.source,
      feed: feedOf.get(newsKey(it.title)) ?? "rss",
      published_at: it.publishedAt ? iso(it.publishedAt) : null,
      snippet: it.snippet,
      label: r.label,
      confidence: r.confidence,
      conflict: r.conflict,
      rule_ids: r.ruleIds,
      reasons: r.reasons,
      explanation: explainImpact(r),
      relevance,
    });
  }
  if (rows.length) {
    const { error } = await db.from("news_items").upsert(rows, { onConflict: "dedupe_key", ignoreDuplicates: true });
    if (error) throw new Error(`news_items: ${error.message}`);
  }

  // ---- kalender ekonomi: maksimal sekali per jam (hormati sumber gratis) ----
  let calendar: number | string = "cached";
  const { data: last } = await db.from("econ_events").select("fetched_at").order("fetched_at", { ascending: false }).limit(1).maybeSingle();
  if (!last || t0 - (sec(last.fetched_at) ?? 0) >= 3600) {
    try {
      // hanya event FOMC / NFP / CPI / PPI (apa pun label dampaknya di sumber)
      const events = parseFfCalendar(JSON.parse(await fetchText(FF_URL)), ["USD"], ["High", "Medium", "Low"]).filter((e) => calendarTopic(e.title));
      const fetchedAt = iso(t0);
      if (events.length) {
        const { error } = await db.from("econ_events").upsert(
          events.map((e) => ({ event_key: e.key, topic: calendarTopic(e.title), title: e.title, country: e.country, impact: e.impact, time_at: iso(e.timeSec), forecast: e.forecast, previous: e.previous, fetched_at: fetchedAt })),
          { onConflict: "event_key" },
        );
        if (error) throw new Error(error.message);
        // event yang dijadwal ulang/dihapus sumber dalam rentang minggu ini
        await db.from("econ_events").delete().gte("time_at", iso(events[0].timeSec)).lte("time_at", iso(events[events.length - 1].timeSec)).lt("fetched_at", fetchedAt);
      }
      calendar = events.length;
    } catch (e) {
      calendar = scrub((e as Error).message);
    }
  }

  return { feeds, candidates: fresh.length, inserted: rows.length, embedded, embedder: getEmbedder() ? "gte-small" : "keyword-only", calendar };
}

// ---------------------------------------------------------------------------
// Backtest panjang bertahap: satu potongan 7 hari per pemanggilan (batas CPU
// Edge), data riwayat XAU/USD Twelve Data (bila key ada; 4 kredit/potongan) atau
// Binance PAXG/USDT, hanya jam pasar emas. Hasil per trade disimpan, lalu
// diringkas ulang: probabilitas (Live Opportunities) + laporan manajemen posisi
// (Statistik → Backtest) — hanya setelah semua potongan versi ini lengkap.
// ---------------------------------------------------------------------------
const BT_MONTHS = Number(env("BACKTEST_MONTHS", "12"));
/** naikkan bila logika strategi/simulasi berubah → semua potongan dihitung ulang */
const STRATEGY_CODE_VERSION = "2026-10-22.7"; // .7: hanya M15/M30/H1 (bias H1+M30, setup M15 & M30, konfirmasi M15)
// pemanasan per TF (hari kalender): analisis memakai 220 bar terakhir (EMA200) — termasuk akhir pekan
const BT_WARMUP_DAYS: Partial<Record<Timeframe, number>> = { H4: 60, H1: 16, M30: 9, M15: 5, M5: 4 };
const BT_SOURCE_LABEL: Record<string, string> = {
  twelvedata: "Twelve Data — XAU/USD, jam pasar emas",
  binance_paxg: "Binance — PAXG/USDT (proxy emas), jam pasar emas",
};
/** strategi yang ikut disimulasikan untuk RISET (tidak tampil di ringkasan/probabilitas live) */
const RESEARCH_STRATEGIES: EngineConfig["strategies"] = ["liquidity_sweep", "sd_reversal"];
/** toleransi invalidasi yang ikut disimulasikan untuk RISET; ringkasan live hanya memakai trade dengan invSlackPips ≤ toleransi live */
const BT_INV_TOL_PIPS = 5;
/** batas SL minimum (× ATR konteks) yang ikut disimulasikan untuk RISET; ringkasan live memfilter features.slAtrCtx */
const BT_MIN_SL_ATR_CTX = 0.6;

/**
 * Versi = apa yang DISIMULASIKAN (gabungan strategi live + riset, toleransi riset), bukan pilihan live:
 * memindahkan strategi riset ke live atau menaikkan toleransi live tidak menghitung ulang backtest.
 */
async function strategyVersion(btCfg: EngineConfig, o: typeof DEFAULT_BT, source: string): Promise<string> {
  const { spec: _spec, strategies, ...strategy } = btCfg;
  const simulated = [...strategies].sort();
  const bytes = new TextEncoder().encode(JSON.stringify({ code: STRATEGY_CODE_VERSION, source, simulated, strategy, o }));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash.slice(0, 6), (b) => b.toString(16).padStart(2, "0")).join("");
}

function tradeRow(t: BacktestTrade, version: string, chunkStart: number) {
  return {
    version,
    chunk_start: iso(chunkStart),
    created_at: iso(t.createdAt),
    strategy: t.strategy,
    timeframe: t.timeframe,
    direction: t.direction,
    session: t.session,
    sl_pips: t.slPips,
    entry_touched: t.entryTouched,
    invalid_before: t.invalidBeforeEntry,
    tp: t.tp,
    ambiguous: t.ambiguous,
    pips: t.pips,
    features: t.features ?? null,
  };
}

async function loadTrades(db: Db, version: string): Promise<(BacktestTrade & { invSlack: number; slAtrCtx: number })[]> {
  const out: (BacktestTrade & { invSlack: number; slAtrCtx: number })[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("backtest_trades").select("created_at,strategy,timeframe,direction,session,sl_pips,entry_touched,invalid_before,tp,ambiguous,pips,inv_slack:features->invSlackPips,sl_atr_ctx:features->slAtrCtx").eq("version", version).order("created_at").range(from, from + 999);
    if (error) throw new Error(`load trades: ${error.message}`);
    for (const r of data ?? []) {
      out.push({ createdAt: sec(r.created_at)!, strategy: r.strategy, timeframe: r.timeframe, direction: r.direction, session: r.session, slPips: r.sl_pips, entryTouched: r.entry_touched, invalidBeforeEntry: r.invalid_before, tp: r.tp, ambiguous: r.ambiguous, pips: r.pips, invSlack: Number(r.inv_slack ?? 0), slAtrCtx: Number(r.sl_atr_ctx ?? Infinity) });
    }
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function backtest(db: Db, cfg: EngineConfig, _pid: string) {
  const o = { ...DEFAULT_BT, spreadPips: ASSUMED_SPREAD_PIPS, window: 220 };
  const hist = tdKey ? createProvider("twelvedata", { twelveDataKey: tdKey }) : createProvider("binance_paxg", {});
  const BT_SOURCE = BT_SOURCE_LABEL[hist.id];
  const btCfg: EngineConfig = {
    ...cfg,
    strategies: [...new Set([...cfg.strategies, ...RESEARCH_STRATEGIES])],
    invalidationTolPips: Math.max(cfg.invalidationTolPips, BT_INV_TOL_PIPS),
    minSlAtrContext: Math.min(cfg.minSlAtrContext, BT_MIN_SL_ATR_CTX),
  };
  const version = await strategyVersion(btCfg, o, hist.id);
  const nowSec = Math.floor(Date.now() / 1000);
  const { data: doneRows, error: dErr } = await db.from("backtest_chunks").select("chunk_start,computed_at").eq("version", version);
  if (dErr) throw new Error(`chunks: ${dErr.message}`);
  const start = nextChunk((doneRows ?? []).map((r) => ({ start: sec(r.chunk_start)!, computedAt: sec(r.computed_at)! })), nowSec, BT_MONTHS);
  if (start == null) return { version, idle: true, chunks: doneRows?.length ?? 0 };

  // ---- data riwayat potongan ini (+ pemanasan, + 1 hari masa simulasi) ----
  const end = start + CHUNK_SEC;
  const simEnd = Math.min(end + 86400 + 3600, nowSec);
  const candles: Partial<Record<Timeframe, Candle[]>> = {};
  const bars: Record<string, number> = {};
  // TF analisis + H1 (fitur riset hari sebelumnya)
  for (const tf of [...new Set<Timeframe>([...analysisTfs(btCfg), "H1"])]) {
    const from = start - (BT_WARMUP_DAYS[tf] ?? 5) * 86400;
    const count = Math.ceil((simEnd - from) / TF_SECONDS[tf]) + 2;
    const raw = await hist.fetchCandles(tf, count, simEnd);
    candles[tf] = marketHoursOnly(raw.filter((c) => c.time >= from), tf);
    bars[tf] = candles[tf]!.length;
  }

  const trades = runBacktestTrades(candles, btCfg, o, { fromSec: start, toSec: Math.min(end, nowSec) });
  await db.from("backtest_trades").delete().eq("version", version).eq("chunk_start", iso(start));
  for (let i = 0; i < trades.length; i += 500) {
    const { error } = await db.from("backtest_trades").insert(trades.slice(i, i + 500).map((t) => tradeRow(t, version, start)));
    if (error) throw new Error(`insert trades: ${error.message}`);
  }
  await db.from("backtest_chunks").upsert({ chunk_start: iso(start), version, computed_at: iso(nowSec), setups: trades.length, touched: trades.filter((t) => t.entryTouched).length }, { onConflict: "chunk_start,version" });

  // ---- ringkas ulang seluruh potongan versi ini ----
  // ringkasan & probabilitas live: hanya strategi live dan trade yang lolos gate live (toleransi invalidasi, SL/ATR konteks)
  const all = (await loadTrades(db, version)).filter(
    (t) => (cfg.strategies as string[]).includes(t.strategy) && t.invSlack <= cfg.invalidationTolPips + 1e-9 && t.slAtrCtx >= cfg.minSlAtrContext - 1e-9,
  );
  const { count: chunks } = await db.from("backtest_chunks").select("chunk_start", { count: "exact", head: true }).eq("version", version);
  // versi baru belum lengkap → laporan & probabilitas versi lama tetap tampil (tidak diganti sampel kecil)
  const complete = (chunks ?? 0) >= expectedChunks(nowSec, BT_MONTHS);
  if (!complete) return { version, source: hist.id, chunk: iso(start), bars, setups: trades.length, touched: trades.filter((t) => t.entryTouched).length, chunks, complete };
  const report = summarizeTrades(all, o);
  if (report) {
    await db.from("strategy_report").upsert({ id: "current", version, computed_at: iso(nowSec), source: BT_SOURCE, chunks: chunks ?? 0, report });
    const rows = probabilityReports(all, o).map((r) => ({
      key: r.key,
      computed_at: new Date().toISOString(),
      source: `${BT_SOURCE}, ${chunks ?? 0} minggu`,
      period_from: iso(r.periodFrom),
      period_to: iso(r.periodTo),
      split_at: iso(r.splitAt),
      dev: r.dev,
      test: r.test,
      sufficient: r.sufficient,
      options: r.options,
    }));
    if (rows.length) await db.from("probability_stats").upsert(rows, { onConflict: "key" });
  }
  // versi strategi lama tidak relevan lagi
  await db.from("backtest_trades").delete().neq("version", version);
  await db.from("backtest_chunks").delete().neq("version", version);

  return { version, source: hist.id, chunk: iso(start), bars, setups: trades.length, touched: trades.filter((t) => t.entryTouched).length, totalTrades: all.length, chunks, complete };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  if (!(await authorized(db, req.headers.get("x-engine-secret") ?? ""))) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const mode = body?.mode === "backtest" ? "backtest" : body?.mode === "news" ? "news" : "tick";
  const { data: run } = await db.from("engine_runs").insert({ mode }).select("id").single();
  const { data: st } = await db.from("engine_state").select("config").eq("id", "engine").maybeSingle();
  const cfg = mergeConfig(st?.config ?? null);
  try {
    tdKey = mode === "news" ? "" : await loadTdKey(db);
    const pid = providerId(st?.config);
    const result = mode === "backtest" ? await backtest(db, cfg, pid) : mode === "news" ? await news(db) : await tick(db, cfg, pid);
    await db.from("engine_runs").update({ finished_at: new Date().toISOString(), ok: !("error" in result && result.error), stats: result }).eq("id", run?.id);
    return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
  } catch (e) {
    const msg = scrub((e as Error).message);
    console.error("engine error", msg);
    await db.from("engine_runs").update({ finished_at: new Date().toISOString(), ok: false, message: msg }).eq("id", run?.id);
    return new Response(JSON.stringify({ error: "engine_failed" }), { status: 500 });
  }
});
