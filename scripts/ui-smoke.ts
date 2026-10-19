// Uji asap UI: menyajikan build statis (out/), me-mock Supabase dengan data yang
// dihasilkan engine yang sama (data DEMO), lalu mengambil screenshot desktop & mobile
// dan memeriksa tidak ada scroll horizontal / elemen yang meluber.
//   npx tsx scripts/ui-smoke.ts   (setelah `npm run build`)
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import handler from "serve-handler";
import { chromium, type Route } from "playwright-core";
import { runEngineCycle } from "../src/core/engine.ts";
import { DEFAULT_ENGINE_CONFIG } from "../src/core/config.ts";
import { demoPrice, demoProvider } from "../src/core/providers.ts";
import { TF_SECONDS, type Timeframe } from "../src/core/types.ts";
import { barOverlapsMarket, demoCandle } from "../src/core/providers.ts";
import { evaluateOutcome } from "../src/core/outcome.ts";
import { summarizeTrades, type BacktestTrade } from "../src/core/backtest.ts";
import { DEFAULT_XAUUSD } from "../src/core/instrument.ts";
import { calendarTopic, classifyGoldImpact, explainImpact, newsTopic } from "../src/core/news.ts";

const ROOT = join(import.meta.dirname, "..");
const OUT = process.env.SHOT_DIR ?? join(ROOT, "docs/screenshots");
mkdirSync(OUT, { recursive: true });
const REF = "acyvxbqyxdorkrqeibtk";
const NOW = Date.parse("2026-10-14T09:12:00Z") / 1000; // Rabu, sesi London
const iso = (s: number) => new Date(s * 1000).toISOString();
const UID = "11111111-1111-1111-1111-111111111111";

function series(tf: Timeframe, end: number, count: number) {
  const step = TF_SECONDS[tf];
  const out = [];
  for (let t = end - (end % step); out.length < count; t -= step) {
    if (step < 86400 && !barOverlapsMarket(t, step)) continue;
    out.unshift(demoCandle(tf, t));
  }
  return out;
}

// --- fixture dari engine nyata atas data demo ---
const view = (t: number) => ({ H4: series("H4", t, 300), H1: series("H1", t, 300), M30: series("M30", t, 300), M15: series("M15", t, 300), M5: series("M5", t, 300) });
const raw = view(NOW);
let setups: Record<string, unknown>[] = [];
for (let t = NOW - 6 * 3600; t <= NOW; t += 900) {
  const r = view(t);
  const o = runEngineCycle({ nowSec: t, rawCandles: r, price: demoPrice(t / 60), quoteTimeSec: t, spreadPips: 3, assumedSpreadPips: 3, feedStatus: "demo", previousFeedStatus: "demo", existing: setups.map((s) => s.__stored as never), config: DEFAULT_ENGINE_CONFIG });
  for (const c of o.created) {
    const id = `00000000-0000-4000-8000-${String(setups.length + 1).padStart(12, "0")}`;
    setups.push({
      id, identity_key: c.identityKey, created_at: new Date(c.createdAt * 1000).toISOString(), expires_at: new Date(c.expiresAt * 1000).toISOString(), updated_at: new Date(NOW * 1000).toISOString(),
      direction: c.direction, strategy: c.strategy, timeframe: c.timeframe, confirm_tf: c.confirmTf, entry_type: c.entryType, entry_price: c.entry, entry_low: c.entryLow, entry_high: c.entryHigh,
      invalidation: Number.isFinite(c.invalidation) ? c.invalidation : null, sl: c.sl, tp1: c.tp1, tp2: c.tp2, tp3: c.tp3, sl_pips: 50, pip_size: 0.1, rr: c.rr, spread_pips: 3, score: c.score.total,
      score_breakdown: c.score, gates: c.gates, eligible: c.eligible, reasons: c.reasons, status: c.eligible ? (c.expiresAt > NOW ? "approaching" : "expired") : "invalid",
      status_reason: c.eligible ? "Setup valid." : "Tidak layak: " + c.gates.filter((g) => !g.pass).map((g) => g.note).join(" "), confirmed_at: null, confirmation: null, entry_touched_at: null,
      last_price: demoPrice(NOW / 60), distance_pips: null, session: o.session, data_source: "Demo — data simulasi", data_time: new Date(t * 1000).toISOString(),
      __stored: { id, identity_key: c.identityKey, strategy: c.strategy, direction: c.direction, timeframe: c.timeframe, confirm_tf: c.confirmTf, entry_type: c.entryType, entry_price: c.entry, entry_low: c.entryLow, entry_high: c.entryHigh, invalidation: c.invalidation, sl: c.sl, created_at_sec: c.createdAt, expires_at_sec: c.expiresAt, status: c.eligible ? "approaching" : "invalid", eligible: c.eligible, confirmed_at_sec: null, entry_touched_at_sec: null },
    });
  }
}
setups = setups.map(({ __stored, ...s }) => ({ ...s, outcome: null, outcome_tp: null, outcome_pips: null, outcome_at: null, outcome_note: null, outcome_ambiguous: false })).reverse();

// Riwayat sinyal: setup historis dari engine yang sama, hasilnya dinilai evaluateOutcome pada candle demo
const history: Record<string, unknown>[] = [];
let hist: Record<string, unknown>[] = [];
for (let t = NOW - 3 * 86400; t <= NOW - 6 * 3600 && history.length < 8; t += 900) {
  const r = view(t);
  const o = runEngineCycle({ nowSec: t, rawCandles: r, price: demoPrice(t / 60), quoteTimeSec: t, spreadPips: 3, assumedSpreadPips: 3, feedStatus: "demo", previousFeedStatus: "demo", existing: hist as never, config: DEFAULT_ENGINE_CONFIG });
  for (const c of o.created) {
    hist.push({ id: c.identityKey, identity_key: c.identityKey, strategy: c.strategy, direction: c.direction, timeframe: c.timeframe, confirm_tf: c.confirmTf, entry_type: c.entryType, entry_price: c.entry, entry_low: c.entryLow, entry_high: c.entryHigh, invalidation: c.invalidation, sl: c.sl, created_at_sec: c.createdAt, expires_at_sec: c.expiresAt, status: "approaching", eligible: c.eligible, confirmed_at_sec: null, entry_touched_at_sec: null });
    if (!c.eligible) continue;
    const fut = series("M5", Math.min(NOW, c.createdAt + 86400), 320).filter((b) => b.time > c.createdAt);
    const touch = c.entryType === "market" ? fut[0] : fut.find((b) => b.low <= c.entry && b.high >= c.entry);
    if (!touch) continue;
    const res = evaluateOutcome({ direction: c.direction, entry: c.entry, sl: c.sl, tps: [c.tp1, c.tp2, c.tp3], entryTouchedAtSec: touch.time, candles: fut, barSec: 300, price: null, nowSec: Math.min(NOW, touch.time + 86400), maxHoldSec: 86400, spec: DEFAULT_XAUUSD });
    history.push({ ...setups[0], id: `00000000-0000-4000-9000-${String(history.length + 1).padStart(12, "0")}`, direction: c.direction, strategy: c.strategy, timeframe: c.timeframe, entry_price: c.entry, sl: c.sl, tp1: c.tp1, tp2: c.tp2, tp3: c.tp3, score: c.score.total, status: "entry_touched", entry_touched_at: iso(touch.time), outcome: res.outcome, outcome_tp: res.tpHit, outcome_pips: res.pips, outcome_note: res.note, outcome_ambiguous: res.ambiguous });
  }
}
// sinyal berjalan (TP1 sudah tersentuh) agar badge "TP1 ✓" + floating + tangga TP ikut diuji
if (setups[0]) {
  const p0 = demoPrice(NOW / 60);
  history.unshift({ ...setups[0], id: "00000000-0000-4000-9000-000000000099", direction: "SELL", timeframe: "M15", entry_price: p0 + 6, sl: p0 + 11, tp1: p0 + 1, tp2: p0 - 4, tp3: p0 - 9, status: "entry_touched", entry_touched_at: iso(NOW - 1800), outcome: "open", outcome_tp: 1, outcome_pips: null, outcome_note: "TP1 tersentuh, pelacakan berlanjut.", outcome_ambiguous: false });
}
console.log(`Riwayat sinyal fixture: ${history.length}`);
const out = runEngineCycle({ nowSec: NOW, rawCandles: raw, price: demoPrice(NOW / 60), quoteTimeSec: NOW, spreadPips: 3, assumedSpreadPips: 3, feedStatus: "live", previousFeedStatus: "live", existing: [], config: DEFAULT_ENGINE_CONFIG });
const q = await demoProvider().fetchQuote(NOW);
const fixtures: Record<string, unknown> = {
  market_snapshot: { id: "current", source: "demo", source_label: "Demo — data simulasi", proxy_note: "Data SIMULASI untuk demonstrasi. Bukan harga pasar.", is_demo: true, supports_bid_ask: true, price: q.price, bid: q.bid, ask: q.ask, spread_pips: 3, day_open: q.dayOpen, day_high: q.dayHigh, day_low: q.dayLow, day_change: q.price - q.dayOpen!, day_change_pct: ((q.price - q.dayOpen!) / q.dayOpen!) * 100, quote_time: iso(NOW), fetched_at: iso(NOW), feed_status: "demo", market_open: true, consecutive_failures: 0, next_retry_at: null, last_error: null, updated_at: iso(NOW) },
  analysis_snapshots: {
    id: 1, created_at: iso(NOW), source: "demo", status: out.status, main_bias: out.analysis.mainBias, strong_bias: out.analysis.strongBias, quality_ok: out.quality.ok, quality_reasons: out.quality.reasons, reasons: out.analysis.reasons,
    timeframes: Object.fromEntries(Object.entries(out.analysis.tfs).map(([k, a]) => [k, { bias: a!.bias, structure: a!.structure.label, close: a!.lastClose, ema20: a!.ema20, ema50: a!.ema50, ema200: Number.isFinite(a!.ema200) ? a!.ema200 : null, rsi: a!.rsi, atr: a!.atr, slope: a!.ema50SlopeAtr, bars: a!.bars, last_time: iso(a!.lastTime) }])),
    levels: (out.analysis.tfs.M15?.levels ?? []).filter((l) => l.touches >= 2).map((l) => ({ ...l, tf: "M15" })), session: out.session, price: q.price, data_time: iso(NOW),
  },
  setups: [...setups, ...history],
  notifications: setups.slice(0, 5).map((s, i) => ({ id: `n-${i}`, created_at: s.created_at, kind: "new_setup", title: `Setup ${s.direction} baru — ${s.timeframe}`, body: `Entry ${s.entry_price}`, severity: "info", setup_id: s.id, score: s.score, timeframe: s.timeframe })),
  user_settings: { user_id: UID, display_tz: "Asia/Jakarta", broker_name: "Contoh", pip_size: 0.1, tick_size: 0.01, digits: 2, contract_size: 100, lot_step: 0.01, min_lot: 0.01, max_lot: 100, commission_per_lot: 7, account_currency: "USD", quote_to_account_rate: 1, account_balance: 5000, risk_percent: 1, default_spread_pips: 3, sl_pips: 50, tp1_pips: 50, tp2_pips: 100, tp3_pips: 150, near_entry_pips: 20, notify_cooldown_min: 15, min_score: { M15: 60, H1: 60 }, notify_kinds: {}, browser_push: false, starting_balance: 5000 },
  journal_trades: [
    { id: "t1", user_id: UID, setup_id: null, direction: "BUY", strategy: "trend_pullback", timeframe: "M15", session: "london", entry_price: 2990, lot: 0.1, initial_sl: 2985, sl: 2990, tp1: 2995, tp2: 3000, tp3: 3005, opened_at: "2026-10-12T08:10:00Z", closed_at: "2026-10-12T11:00:00Z", status: "closed", outcome: "tp2", tp1_hit_at: "2026-10-12T09:00:00Z", tp2_hit_at: "2026-10-12T11:00:00Z", tp3_hit_at: null, commission: 0.7, swap: 0, contract_size: 100, quote_to_account_rate: 1, notes: "Contoh" },
    { id: "t2", user_id: UID, setup_id: null, direction: "SELL", strategy: "breakout_retest", timeframe: "H1", session: "newyork", entry_price: 3010, lot: 0.1, initial_sl: 3015, sl: 3015, tp1: 3005, tp2: 3000, tp3: 2995, opened_at: "2026-10-13T13:10:00Z", closed_at: "2026-10-13T15:00:00Z", status: "closed", outcome: "sl", tp1_hit_at: null, tp2_hit_at: null, tp3_hit_at: null, commission: 0.7, swap: 0, contract_size: 100, quote_to_account_rate: 1, notes: null },
    { id: "t3", user_id: UID, setup_id: null, direction: "BUY", strategy: "manual", timeframe: "M15", session: "london", entry_price: Number((q.price - 6).toFixed(2)), lot: 0.05, initial_sl: Number((q.price - 11).toFixed(2)), sl: Number((q.price - 11).toFixed(2)), tp1: Number((q.price - 1).toFixed(2)), tp2: null, tp3: null, opened_at: "2026-10-14T08:00:00Z", closed_at: null, status: "open", outcome: null, tp1_hit_at: null, tp2_hit_at: null, tp3_hit_at: null, commission: 0, swap: 0, contract_size: 100, quote_to_account_rate: 1, notes: null },
  ],
  journal_partials: [
    { id: "p1", trade_id: "t1", closed_at: "2026-10-12T11:00:00Z", lot: 0.1, price: 3000, kind: "final" },
    { id: "p2", trade_id: "t2", closed_at: "2026-10-13T15:00:00Z", lot: 0.1, price: 3015, kind: "final" },
  ],
  probability_stats: null,
  notification_reads: [],
  user_alerts: [],
  journal_events: [],
  journal_attachments: [],
  // Backtest strategi: trade sintetis deterministik (bukan hasil nyata) untuk menguji tampilan
  strategy_report: (() => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const sessions = ["asia", "london", "newyork", "off"];
    const trades: BacktestTrade[] = Array.from({ length: 320 }, (_, i) => {
      const tf = rnd() < 0.7 ? "M15" : "H1";
      const sl = tf === "M15" ? 50 : 100;
      const touched = rnd() < 0.78;
      const tp1 = rnd() < 0.53;
      const tp2 = tp1 && rnd() < 0.6;
      const tp3 = tp2 && rnd() < 0.8;
      const lossA = -(sl + 3);
      const A = tp1 ? sl : lossA;
      const B = ((tp1 ? sl : lossA) + (tp2 ? 2 * sl : lossA) + (tp3 ? 3 * sl : lossA)) / 3;
      const C = tp1 ? (sl + (tp2 ? 2 * sl : -3) + (tp3 ? 3 * sl : -3)) / 3 : lossA;
      return {
        createdAt: NOW - (320 - i) * 86400, strategy: rnd() < 0.6 ? "breakout_retest" : "trend_pullback", timeframe: tf, direction: rnd() < 0.5 ? "BUY" : "SELL",
        session: sessions[Math.floor(rnd() * 4)], slPips: sl, entryTouched: touched, invalidBeforeEntry: false, tp: [tp1, tp2, tp3], ambiguous: false,
        pips: touched
          ? (() => {
              const q4 = tp1 || rnd() < 0.55; // TP cepat lebih sering kena
              const q6 = tp1 || (q4 && rnd() < 0.6);
              return { A, B: Math.round(B * 10) / 10, C: Math.round(C * 10) / 10, D: q4 ? 0.4 * sl : lossA, E: q6 ? 0.6 * sl : lossA, F: q6 ? Math.round(((0.6 * sl + (tp2 ? 2 * sl : -3)) / 2) * 10) / 10 : lossA };
            })()
          : null,
      } as BacktestTrade;
    });
    return { id: "current", version: "demo", computed_at: iso(NOW), source: "DEMO — data sintetis untuk uji tampilan", chunks: 46, report: summarizeTrades(trades) };
  })(),
  // News AI: judul contoh diklasifikasi oleh aturan yang sama dengan engine; waktu relatif ke jam browser
  news_items: [
    ["US CPI rises more than expected in September as inflation heats up", "Reuters", 12],
    ["Fed holds rates steady, signals rate cuts ahead", "CNBC", 95],
    ["Dollar slips and Treasury yields fall after weak jobs report", "Reuters", 180],
    ["US producer prices rise 0.6% in September", "Investing.com", 300],
  ].map(([title, source, minAgo], i) => {
    const r = classifyGoldImpact(String(title));
    const t = new Date(Date.now() - Number(minAgo) * 60000).toISOString();
    return { id: `n${i}`, topic: newsTopic(String(title)), title, link: "https://example.com/" + i, source, published_at: t, snippet: "", label: r.label, confidence: r.confidence, conflict: r.conflict, rule_ids: r.ruleIds, reasons: r.reasons, explanation: explainImpact(r), created_at: t };
  }),
  econ_events: [
    ["CPI m/m", "High", 25, "0.3%", "0.4%"],
    ["Core CPI m/m", "High", 25, "0.2%", "0.3%"],
    ["FOMC Statement", "High", 60 * 26, null, null],
    ["Non-Farm Employment Change", "High", -60 * 5, "150K", "142K"],
  ].map(([title, impact, minAhead, forecast, previous]) => ({ event_key: `USD|${title}`, topic: calendarTopic(String(title)), title, country: "USD", impact, time_at: new Date(Date.now() + Number(minAhead) * 60000).toISOString(), forecast, previous, fetched_at: new Date().toISOString() })),
};

async function mockSupabase(route: Route) {
  const url = new URL(route.request().url());
  const m = url.pathname.match(/\/rest\/v1\/(\w+)/);
  if (m) {
    const table = m[1];
    if (table === "market_candles") {
      const tf = (url.searchParams.get("timeframe") ?? "eq.M15").slice(3) as Timeframe;
      const lim = Number(url.searchParams.get("limit") ?? 500);
      const cs = series(tf, NOW, lim).reverse().map((c) => ({ ts: iso(c.time), open: c.open, high: c.high, low: c.low, close: c.close, volume: null }));
      return route.fulfill({ json: cs });
    }
    let data = fixtures[table] ?? [];
    if (table === "setups" && url.searchParams.get("outcome") === "not.is.null") data = (data as Record<string, unknown>[]).filter((r) => r.outcome != null);
    const single = (route.request().headers()["accept"] ?? "").includes("vnd.pgrst.object");
    if (single) {
      if (Array.isArray(data)) data = data[0] ?? null;
      return data == null ? route.fulfill({ status: 406, json: { code: "PGRST116", message: "no rows" } }) : route.fulfill({ json: data });
    }
    return route.fulfill({ json: Array.isArray(data) ? data : data == null ? [] : [data] });
  }
  return route.fulfill({ status: 200, json: {} });
}

const server = createServer((req, res) => handler(req, res, { public: join(ROOT, "out"), trailingSlash: true }));
await new Promise<void>((r) => server.listen(4173, r));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const session = {
  access_token: "mock", refresh_token: "mock", token_type: "bearer", expires_in: 3600 * 24 * 365, expires_at: Math.floor(Date.now() / 1000) + 3600 * 24 * 365,
  user: { id: UID, email: "demo@goldmarket.local", aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-10-01T00:00:00Z" },
};
const pages = ["/", "/opportunities/", "/chart/", "/news/", "/risk/", "/journal/", "/stats/", "/stats/?bt", "/settings/", "/login/"];
const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];
const problems: string[] = [];
for (const vp of viewports) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1, timezoneId: "Asia/Jakarta", locale: "id-ID" });
  await ctx.addInitScript(([k, v]) => {
    if (!location.pathname.startsWith("/login")) localStorage.setItem(k, v);
  }, [`sb-${REF}-auth-token`, JSON.stringify(session)]);
  if (process.env.FIXED_CLOCK) await ctx.clock.setFixedTime(new Date(NOW * 1000)); // opsional: waktu tetap
  await ctx.route(`https://${REF}.supabase.co/**`, mockSupabase);
  await ctx.route("https://s3.tradingview.com/**", (r) => r.abort());
  await ctx.route("https://fonts.googleapis.com/**", (r) => r.abort());
  for (const p of pages) {
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => { if (!errors.length && process.env.DEBUG_STACK) console.log(e.stack?.slice(0, 2500)); errors.push(e.message); });
    await page.goto(`http://localhost:4173${p}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    if (p === "/journal/") await page.locator("section button.w-full").first().click().catch(() => {});
    if (p.endsWith("?bt")) await page.getByRole("button", { name: "Backtest strategi" }).click();
    await page.waitForTimeout(500);
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    if (bg !== "rgb(5, 10, 26)") problems.push(`${vp.name} ${p}: stylesheet tidak termuat (bg ${bg})`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 1) {
      const culprits = await page.evaluate(() => {
        const w = document.documentElement.clientWidth;
        return [...document.querySelectorAll("body *")]
          .filter((el) => el.getBoundingClientRect().right > w + 1 && !el.parentElement?.closest(".overflow-x-auto"))
          .slice(0, 5)
          .map((el) => `${el.tagName.toLowerCase()}.${(el.getAttribute("class") ?? "").split(" ").slice(0, 4).join(".")} (${Math.round(el.getBoundingClientRect().right)})`);
      });
      problems.push(`${vp.name} ${p}: scroll horizontal ${overflow}px → ${culprits.join(", ")}`);
    }
    if (errors.length) problems.push(`${vp.name} ${p}: error JS ${errors.join(" | ")}`);
    const name = `${vp.name}-${p.replace(/\//g, "").replace("?bt", "-backtest") || "dashboard"}.png`;
    await page.screenshot({ path: join(OUT, name), fullPage: vp.name === "mobile" ? false : true });
    if (p === "/opportunities/") {
      // riwayat sinyal: baris berjalan bisa diketuk → tangga TP + floating
      const row = page.getByRole("button", { name: /TP1 ✓/ }).first();
      if ((await row.count()) === 0) problems.push(`${vp.name} ${p}: baris riwayat "TP1 ✓" tidak ditemukan`);
      else {
        await row.click();
        await page.waitForTimeout(300);
        if ((await page.getByText("harga di sini").count()) === 0 && (await page.getByText("Floating").count()) === 0) problems.push(`${vp.name} ${p}: detail sinyal berjalan tidak tampil`);
        await row.scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(OUT, `${vp.name}-signal-history-open.png`) });
      }
    }
    if (p === "/") {
      // panel lonceng harus berlatar solid (konten halaman tidak tembus)
      await page.getByRole("button", { name: /Notifikasi/ }).first().click();
      await page.waitForTimeout(300);
      const panelBg = await page.evaluate(() => {
        const el = [...document.querySelectorAll("span")].find((s) => s.textContent === "Notifikasi")?.closest("div.absolute");
        return el ? getComputedStyle(el).backgroundColor : null;
      });
      if (!panelBg || !/^rgb\(/.test(panelBg)) problems.push(`${vp.name} ${p}: panel notifikasi tidak berlatar solid (${panelBg})`);
      await page.screenshot({ path: join(OUT, `${vp.name}-notifications-open.png`) });
    }
    await page.close();
  }
  await ctx.close();
}
await browser.close();
server.close();
console.log(`Setup fixture: ${setups.length} (layak ${setups.filter((s) => s.eligible).length})`);
console.log(problems.length ? "MASALAH:\n" + problems.join("\n") : "OK: tanpa scroll horizontal & tanpa error JS di semua halaman/viewport");
process.exit(problems.length ? 1 : 0);
