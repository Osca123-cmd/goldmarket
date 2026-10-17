// GOLDMARKET engine — Supabase Edge Function (Deno).
// Dipanggil pg_cron tiap menit (mode "tick") dan harian (mode "backtest").
// Semua secret dibaca dari environment server; tidak ada yang dikirim ke browser.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";
import {
  ACTIVE_STATUSES,
  TF_SECONDS,
  ProviderError,
  backoffSeconds,
  createProvider,
  dedupeCandles,
  deriveFeedStatus,
  isMarketOpenBySchedule,
  mergeConfig,
  priceToPips,
  runBacktest,
  runEngineCycle,
  DEFAULT_BT,
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
const ANALYSIS_TFS: Timeframe[] = ["H4", "H1", "M15", "M5"];

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

/** Provider: env MARKET_PROVIDER > engine_state.config.provider > binance_paxg. */
function providerId(stateConfig: Record<string, unknown> | null | undefined): string {
  return env("MARKET_PROVIDER") || (stateConfig?.provider as string | undefined) || "binance_paxg";
}

/** Pesan error aman untuk log/DB: tanpa API key. */
function scrub(msg: string): string {
  const key = env("TWELVEDATA_API_KEY");
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
  if (p.id === "twelvedata") return tf === "M1" ? 1000 : 5000;
  return { M1: 1000, M5: 5000, M15: 3000, M30: 2000, H1: 2000, H4: 1000, D1: 500 }[tf];
}

/** Ambil candle yang jatuh tempo (bar baru tertutup) + backfill bertahap. Menghormati rate limit. */
async function refreshCandles(db: Db, p: MarketProvider, state: Record<string, unknown>, nowSec: number) {
  const lastFetch = (state.last_candle_fetch ?? {}) as Record<string, number>;
  const backfilled = (state.backfilled ?? {}) as Record<string, boolean>;
  const tfs = STORED_TFS.filter((tf) => tf !== "M1" || p.id !== "twelvedata" || env("TD_INCLUDE_M1") === "true");
  let budget = p.id === "twelvedata" ? Number(env("TD_CREDITS_PER_RUN", "6")) : 20;
  let backfills = 0;
  const fetched: Record<string, number> = {};
  for (const tf of tfs) {
    if (budget <= 0) break;
    const step = TF_SECONDS[tf];
    const last = lastFetch[tf] ?? 0;
    const newBar = Math.floor(nowSec / step) > Math.floor(last / step);
    // Twelve Data (kredit terbatas): hanya saat bar baru. Provider lain: juga perbarui bar berjalan tiap 5 menit.
    const due = newBar || (p.id !== "twelvedata" && nowSec - last >= Math.min(step, 300));
    if (!backfilled[tf]) {
      if (backfills >= 2) continue;
      const c = await p.fetchCandles(tf, backfillSize(p, tf), nowSec);
      fetched[tf] = await upsertCandles(db, p.id, tf, c);
      backfilled[tf] = true;
      lastFetch[tf] = nowSec;
      backfills++;
      budget--;
    } else if (due) {
      const c = await p.fetchCandles(tf, 12, nowSec);
      fetched[tf] = await upsertCandles(db, p.id, tf, c);
      lastFetch[tf] = nowSec;
      budget--;
    }
  }
  return { lastFetch, backfilled, fetched };
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
  const provider = createProvider(pid, { twelveDataKey: env("TWELVEDATA_API_KEY") || undefined });
  const [{ data: snap }, { data: stateRow }] = await Promise.all([
    db.from("market_snapshot").select("*").eq("id", "current").maybeSingle(),
    db.from("engine_state").select("*").eq("id", "engine").maybeSingle(),
  ]);
  const state: Record<string, any> = stateRow ?? { id: "engine", last_candle_fetch: {}, backfilled: {} };
  if (state.provider && state.provider !== provider.id) {
    state.backfilled = {};
    state.last_candle_fetch = {};
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
    const r = await refreshCandles(db, provider, state, t0);
    state.last_candle_fetch = r.lastFetch;
    state.backfilled = r.backfilled;
    fetchInfo = r.fetched;
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

  if (failures === 0) {
    await db.from("market_snapshot").upsert({
      id: "current",
      source: provider.id,
      source_label: provider.label,
      proxy_note: provider.proxyNote,
      is_demo: provider.isDemo,
      supports_bid_ask: provider.supportsBidAsk,
      ...snapFields,
      fetched_at: quote ? iso(t0) : snap?.fetched_at ?? null,
      feed_status: feedStatus,
      market_open: marketOpen,
      consecutive_failures: 0,
      next_retry_at: null,
      last_error: null,
      updated_at: new Date().toISOString(),
    });
  }

  // ---- analisis ----
  const raw: Partial<Record<Timeframe, Candle[]>> = {};
  for (const tf of ANALYSIS_TFS) raw[tf] = await loadCandles(db, provider.id, tf, 300);
  const since = iso(t0 - 3 * 86400);
  const { data: existingRows } = await db
    .from("setups")
    .select("*")
    .or(`status.in.(${ACTIVE_STATUSES.join(",")}),created_at.gte.${since}`)
    .order("created_at", { ascending: false })
    .limit(500);
  const existing = (existingRows ?? []).map(toStored);

  const out = runEngineCycle({
    nowSec: t0,
    rawCandles: raw,
    price,
    quoteTimeSec: quoteTime,
    spreadPips: spreadForEngine,
    assumedSpreadPips: ASSUMED_SPREAD_PIPS,
    feedStatus: provider.isDemo && failures === 0 ? (marketOpen ? "live" : "market_closed") : feedStatus,
    previousFeedStatus: prevStatus,
    existing,
    config: cfg,
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
    ...(out.analysis.tfs.M15?.levels ?? []).map((l) => ({ ...l, tf: "M15" })),
  ].filter((l) => l.touches >= 2 && price != null && Math.abs(l.price - price) < 30);
  await db.from("analysis_snapshots").insert({
    source: provider.id,
    status: out.status,
    main_bias: out.analysis.mainBias,
    strong_bias: out.analysis.strongBias,
    quality_ok: out.quality.ok,
    quality_reasons: out.quality.reasons,
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
  if (notifRows.length) await db.from("notifications").upsert(notifRows, { onConflict: "dedupe_key", ignoreDuplicates: true });

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
  };
}

async function backtest(db: Db, cfg: EngineConfig, pid: string) {
  const provider = createProvider(pid, { twelveDataKey: env("TWELVEDATA_API_KEY") || undefined });
  const bars = Number(env("BACKTEST_BARS", "1500"));
  const candles: Partial<Record<Timeframe, Candle[]>> = {};
  candles.M15 = await loadCandles(db, provider.id, "M15", bars);
  candles.M5 = await loadCandles(db, provider.id, "M5", bars * 3);
  candles.H1 = await loadCandles(db, provider.id, "H1", Math.ceil(bars / 4) + 300);
  candles.H4 = await loadCandles(db, provider.id, "H4", Math.ceil(bars / 16) + 300);
  const reports = runBacktest(candles, { ...cfg, pairs: [{ context: "M15", confirm: "M5" }] }, { ...DEFAULT_BT, spreadPips: ASSUMED_SPREAD_PIPS, window: 220 });
  const rows = reports.map((r) => ({
    key: r.key,
    computed_at: new Date().toISOString(),
    source: provider.label,
    period_from: iso(r.periodFrom),
    period_to: iso(r.periodTo),
    split_at: iso(r.splitAt),
    dev: r.dev,
    test: r.test,
    sufficient: r.sufficient,
    options: r.options,
  }));
  if (rows.length) await db.from("probability_stats").upsert(rows, { onConflict: "key" });
  return { reports: rows.length, bars: Object.fromEntries(Object.entries(candles).map(([k, v]) => [k, v?.length])) };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  if (!(await authorized(db, req.headers.get("x-engine-secret") ?? ""))) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const mode = body?.mode === "backtest" ? "backtest" : "tick";
  const { data: run } = await db.from("engine_runs").insert({ mode }).select("id").single();
  const { data: st } = await db.from("engine_state").select("config").eq("id", "engine").maybeSingle();
  const cfg = mergeConfig(st?.config ?? null);
  try {
    const pid = providerId(st?.config);
    const result = mode === "backtest" ? await backtest(db, cfg, pid) : await tick(db, cfg, pid);
    await db.from("engine_runs").update({ finished_at: new Date().toISOString(), ok: !("error" in result && result.error), stats: result }).eq("id", run?.id);
    return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
  } catch (e) {
    const msg = scrub((e as Error).message);
    console.error("engine error", msg);
    await db.from("engine_runs").update({ finished_at: new Date().toISOString(), ok: false, message: msg }).eq("id", run?.id);
    return new Response(JSON.stringify({ error: "engine_failed" }), { status: 500 });
  }
});
