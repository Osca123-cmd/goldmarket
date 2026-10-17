import { describe, expect, it } from "vitest";
import { runEngineCycle, type EngineInput } from "../src/core/engine.ts";
import { DEFAULT_ENGINE_CONFIG } from "../src/core/config.ts";
import { demoPrice } from "../src/core/providers.ts";
import { analyzeMarket } from "../src/core/analysis.ts";
import { closedAsOf } from "../src/core/dataQuality.ts";
import { sliceClosed } from "../src/core/backtest.ts";
import type { StoredSetup } from "../src/core/setups.ts";
import type { SetupCandidate } from "../src/core/strategies.ts";
import type { Timeframe } from "../src/core/types.ts";
import { demoSeries, demoView } from "./helpers.ts";

const T0 = Date.parse("2026-07-14T10:00:00Z") / 1000;

function input(t: number, over: Partial<EngineInput> = {}): EngineInput {
  return {
    nowSec: t,
    rawCandles: demoView(t),
    price: demoPrice(t / 60),
    quoteTimeSec: t,
    spreadPips: 3,
    assumedSpreadPips: 3,
    feedStatus: "live",
    previousFeedStatus: "live",
    existing: [],
    config: DEFAULT_ENGINE_CONFIG,
    ...over,
  };
}

function toStored(c: SetupCandidate): StoredSetup {
  return {
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
    status: c.eligible ? "approaching" : "invalid",
    eligible: c.eligible,
    confirmed_at_sec: null,
    entry_touched_at_sec: null,
  };
}

describe("engine: validasi data → analisis → setup", () => {
  it("menghasilkan setup dari data yang valid, dengan alasan & gate", () => {
    const out = runEngineCycle(input(T0));
    expect(out.quality.ok).toBe(true);
    expect(out.created.length).toBeGreaterThan(0);
    for (const c of out.created) {
      expect(c.reasons.length).toBeGreaterThan(0);
      expect(c.gates.map((g) => g.key)).toEqual(["data", "structure", "invalidation", "volatility", "risk"]);
      expect(c.eligible).toBe(c.gates.every((g) => g.pass));
      expect(c.score.total).toBeLessThanOrEqual(100);
    }
  });

  it("tidak ada sinyal duplikat: siklus berulang pada candle berdekatan tidak membuat setup sama", () => {
    let existing: StoredSetup[] = [];
    const keys: string[] = [];
    for (let t = T0; t < T0 + 6 * 3600; t += 300) {
      const out = runEngineCycle(input(t, { existing }));
      for (const c of out.created) keys.push(c.identityKey);
      existing = [...existing, ...out.created.map(toStored)];
    }
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
    // tidak ada dua setup aktif sama arah/strategi/TF dengan entry < dedupePips
    const active = existing.filter((s) => s.status !== "invalid");
    for (let a = 0; a < active.length; a++)
      for (let b = a + 1; b < active.length; b++) {
        const x = active[a], y = active[b];
        if (x.strategy === y.strategy && x.direction === y.direction && x.timeframe === y.timeframe && Math.abs(y.created_at_sec - x.created_at_sec) < 2 * 900)
          expect(Math.abs(x.entry_price - y.entry_price) * 10).toBeGreaterThanOrEqual(DEFAULT_ENGINE_CONFIG.dedupePips * 2);
      }
  }, 30_000);

  it("data basi menghentikan sinyal baru", () => {
    const stale = runEngineCycle(input(T0, { quoteTimeSec: T0 - 600 }));
    expect(stale.quality.ok).toBe(false);
    expect(stale.created).toHaveLength(0);
    expect(stale.status).toBe("no_valid_setup");
  });

  it("koneksi bermasalah atau candle hilang menghentikan sinyal baru", () => {
    expect(runEngineCycle(input(T0, { feedStatus: "reconnecting" })).created).toHaveLength(0);
    const raw = demoView(T0);
    raw.M5 = raw.M5!.filter((_, i, arr) => i !== arr.length - 5); // hapus satu candle M5
    const gap = runEngineCycle(input(T0, { rawCandles: raw }));
    expect(gap.quality.reasons.join(" ")).toMatch(/hilang/);
    expect(gap.created).toHaveLength(0);
  });

  it("notifikasi gangguan koneksi hanya saat transisi", () => {
    const a = runEngineCycle(input(T0, { feedStatus: "reconnecting", previousFeedStatus: "live" }));
    expect(a.notifications.some((n) => n.kind === "connection")).toBe(true);
    const b = runEngineCycle(input(T0, { feedStatus: "reconnecting", previousFeedStatus: "reconnecting" }));
    expect(b.notifications.some((n) => n.kind === "connection")).toBe(false);
  });
});

describe("tanpa candle masa depan (anti look-ahead)", () => {
  it("analisis pada waktu t identik walau data sesudah t tersedia", () => {
    const t = T0;
    const later = t + 12 * 3600;
    const tfs: Timeframe[] = ["H4", "H1", "M15", "M5"];
    const past: Partial<Record<Timeframe, ReturnType<typeof demoSeries>>> = {};
    const withFuture: typeof past = {};
    for (const tf of tfs) {
      past[tf] = closedAsOf(demoSeries(tf, t, 300), tf, t);
      withFuture[tf] = sliceClosed(demoSeries(tf, later, 800), tf, t, past[tf]!.length);
    }
    for (const tf of tfs) {
      expect(withFuture[tf]!.length).toBe(past[tf]!.length);
      expect(withFuture[tf]!.at(-1)!.time).toBe(past[tf]!.at(-1)!.time);
    }
    const a = analyzeMarket({ nowSec: t, candles: past });
    const b = analyzeMarket({ nowSec: t, candles: withFuture });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("bar yang masih berjalan tidak dipakai untuk konfirmasi", () => {
    const t = T0 + 120; // 2 menit ke dalam bar M5
    const raw = demoSeries("M5", t, 50);
    const closed = closedAsOf(raw, "M5", t);
    expect(closed.length).toBe(raw.length - 1);
    expect(closed.at(-1)!.time + 300).toBeLessThanOrEqual(t);
  });
});
