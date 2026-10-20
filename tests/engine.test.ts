import { describe, expect, it } from "vitest";
import { readyTitle, runEngineCycle, type EngineInput } from "../src/core/engine.ts";
import { DEFAULT_ENGINE_CONFIG, mergeConfig, planFor } from "../src/core/config.ts";
import { demoPrice } from "../src/core/providers.ts";
import { analyzeMarket } from "../src/core/analysis.ts";
import { closedAsOf } from "../src/core/dataQuality.ts";
import { sliceClosed } from "../src/core/backtest.ts";
import type { StoredSetup } from "../src/core/setups.ts";
import { invalidationGate, type SetupCandidate } from "../src/core/strategies.ts";
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
    raw.M15 = raw.M15!.filter((_, i, arr) => i !== arr.length - 5); // hapus satu candle M15 (TF konfirmasi)
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

describe("rencana SL/TP per timeframe", () => {
  it("default: M15 50/50/100/150, H1 100/100/200/300; override parsial tergabung", () => {
    expect(planFor(DEFAULT_ENGINE_CONFIG, "M15")).toEqual({ slPips: 50, tp1Pips: 50, tp2Pips: 100, tp3Pips: 150 });
    expect(planFor(DEFAULT_ENGINE_CONFIG, "H1")).toEqual({ slPips: 100, tp1Pips: 100, tp2Pips: 200, tp3Pips: 300 });
    expect(planFor(DEFAULT_ENGINE_CONFIG, "H4")).toEqual(DEFAULT_ENGINE_CONFIG.plan);
    const m = mergeConfig({ planByTf: { H1: { slPips: 80 } as never } });
    expect(planFor(m, "H1")).toEqual({ slPips: 80, tp1Pips: 100, tp2Pips: 200, tp3Pips: 300 });
    expect(planFor(m, "M15").slPips).toBe(50);
  });

  it("setiap setup memakai level dari rencana TF-nya (jarak SL/TP persis, tidak diubah diam-diam)", () => {
    const seen = new Set<string>();
    for (let t = T0; t < T0 + 3 * 86400; t += 3600) {
      for (const c of runEngineCycle(input(t)).created) {
        const plan = planFor(DEFAULT_ENGINE_CONFIG, c.timeframe);
        const pip = DEFAULT_ENGINE_CONFIG.spec.pipSize;
        const sgn = c.direction === "BUY" ? 1 : -1;
        expect(c.slPips).toBe(plan.slPips);
        expect(Math.round((sgn * (c.entry - c.sl)) / pip)).toBe(plan.slPips);
        expect(Math.round((sgn * (c.tp3 - c.entry)) / pip)).toBe(plan.tp3Pips);
        seen.add(c.timeframe);
      }
    }
    expect(seen.has("M15")).toBe(true);
  }, 60_000);
});

describe("blackout news FOMC/NFP/CPI/PPI", () => {
  it("setup baru ditahan selama jendela rilis; alasan dicatat; tanpa blackout setup tetap dibuat", () => {
    const normal = runEngineCycle(input(T0));
    expect(normal.created.length).toBeGreaterThan(0);
    expect(normal.blackoutReason).toBeNull();
    const held = runEngineCycle(input(T0, { newsBlackout: { title: "CPI m/m", timeSec: T0 + 600 } }));
    expect(held.created).toHaveLength(0);
    expect(held.blackoutReason).toMatch(/CPI m\/m dalam 10 menit/);
    expect(held.rejected.length).toBeGreaterThanOrEqual(normal.created.length);
    const off = runEngineCycle(input(T0, { newsBlackout: { title: "CPI m/m", timeSec: T0 }, config: { ...DEFAULT_ENGINE_CONFIG, newsBlackoutMin: 0 } }));
    expect(off.created.length).toBe(normal.created.length);
  });
});

describe("strategi liquidity sweep (riset)", () => {
  it("terdeteksi pada data demo dengan invalidasi di luar ujung sweep dan level sesuai rencana TF", () => {
    const cfg = { ...DEFAULT_ENGINE_CONFIG, strategies: ["liquidity_sweep" as const] };
    const found: SetupCandidate[] = [];
    for (let t = T0; t < T0 + 5 * 86400 && found.length < 3; t += 900) {
      found.push(...runEngineCycle(input(t, { config: cfg })).created.filter((c) => c.strategy === "liquidity_sweep"));
    }
    expect(found.length).toBeGreaterThan(0);
    for (const c of found) {
      const s = c.direction === "BUY" ? 1 : -1;
      expect(c.reasons.some((r) => r.includes("likuiditas diambil"))).toBe(true);
      expect(s * (c.entry - c.invalidation)).toBeGreaterThan(0); // invalidasi di sisi SL
      expect(c.slPips).toBe(planFor(DEFAULT_ENGINE_CONFIG, c.timeframe).slPips);
    }
  }, 120_000);

  it("tidak aktif di sinyal live secara default", () => {
    expect(DEFAULT_ENGINE_CONFIG.strategies).not.toContain("liquidity_sweep");
  });
});

describe("gate SL vs invalidasi + toleransi", () => {
  it("SL 0,8 pip di dalam struktur (kasus Senin 07:00 WIB): gagal tanpa toleransi, lolos dengan toleransi 5 pips", () => {
    // BUY entry 4179.65, SL 4174.65, invalidasi 4174.57 → SL 0.08 di dalam
    expect(invalidationGate("BUY", 4179.65, 4174.65, 4174.57, 0).ok).toBe(false);
    const g = invalidationGate("BUY", 4179.65, 4174.65, 4174.57, 0.5);
    expect(g.ok).toBe(true);
    expect(g.insideBy).toBeCloseTo(0.08, 6);
  });
  it("jauh di dalam struktur tetap gagal; SL di luar invalidasi lolos; SELL simetris", () => {
    expect(invalidationGate("BUY", 4174.66, 4169.8, 4160.36, 0.5).ok).toBe(false); // 94 pips di dalam
    expect(invalidationGate("BUY", 3000, 2995, 2996, 0)).toEqual({ between: true, insideBy: 0, ok: true });
    expect(invalidationGate("SELL", 3000, 3005, 3005.3, 0.5).ok).toBe(true); // SELL: SL 0.3 di bawah invalidasi
    expect(invalidationGate("SELL", 3000, 3005, 3006, 0.5).ok).toBe(false);
    expect(invalidationGate("BUY", 2995, 2990, 2996, 0.5).between).toBe(false); // entry sudah melewati invalidasi
  });
  it("default live tetap ketat (0 pips)", () => {
    expect(DEFAULT_ENGINE_CONFIG.invalidationTolPips).toBe(0);
  });
});

describe("strategi supply/demand reversal (riset)", () => {
  it("hanya muncul saat TF bias besar (H1) ranging; boleh melawan bias M30; invalidasi di sisi SL; level sesuai rencana TF", () => {
    const cfg = { ...DEFAULT_ENGINE_CONFIG, strategies: ["sd_reversal" as const] };
    const found: { c: SetupCandidate; h4: string }[] = [];
    for (let t = T0; t < T0 + 10 * 86400 && found.length < 5; t += 900) {
      const out = runEngineCycle(input(t, { config: cfg }));
      for (const c of out.created) found.push({ c, h4: out.analysis.tfs[DEFAULT_ENGINE_CONFIG.biasTfs.major]?.bias ?? "" });
    }
    expect(found.length).toBeGreaterThan(0);
    for (const { c, h4 } of found) {
      const s = c.direction === "BUY" ? 1 : -1;
      expect(c.strategy).toBe("sd_reversal");
      expect(h4).toBe("ranging");
      expect(s * (c.entry - c.invalidation)).toBeGreaterThan(0);
      expect(c.slPips).toBe(planFor(DEFAULT_ENGINE_CONFIG, c.timeframe).slPips);
    }
  }, 180_000);

  it("tidak aktif di sinyal live secara default", () => {
    expect(DEFAULT_ENGINE_CONFIG.strategies).not.toContain("sd_reversal");
  });
});

describe("label eksperimen", () => {
  it("notifikasi strategi eksperimen diberi label; strategi live biasa tidak", () => {
    expect(readyTitle("SELL", "M15", "", "sd_reversal")).toBe("🔴 READY SELL XAUUSD — M15 · 🧪 Eksperimen");
    expect(readyTitle("BUY", "H1", " · 12.0 pips lagi", "breakout_retest")).toBe("🟢 READY BUY XAUUSD — H1 · 12.0 pips lagi");
    expect(readyTitle("BUY", "M15", "", "liquidity_sweep")).toBe("🟢 READY BUY XAUUSD — M15 · 🧪 Eksperimen");
    expect(readyTitle("SELL", "M30", "", "crt")).toBe("🔴 READY SELL XAUUSD — M30 · 🧪 Eksperimen");
    expect(readyTitle("BUY", "M15", "", "msnr_flip")).toBe("🟢 READY BUY XAUUSD — M15 · 🧪 Eksperimen");
  });
});

describe("jam istirahat", () => {
  const quiet = { label: "23.10–05.00 WIB", startHour: 23, startMinute: 10, endHour: 5, endMinute: 0, utcOffsetHours: 7 };
  const cfg = mergeConfig({ delivery: { quiet } });
  const t = Date.parse("2026-07-14T16:30:00Z") / 1000; // 23.30 WIB

  it("setup belum kena entry dibatalkan, sinyal berjalan tetap dilacak, rekap dikirim, tidak ada sinyal baru", () => {
    const probe = runEngineCycle(input(t, { config: cfg }));
    const price = demoPrice(t / 60);
    const dir = probe.analysis.mainBias === "bearish" ? "SELL" : "BUY";
    const s = dir === "BUY" ? 1 : -1;
    const base: StoredSetup = {
      id: "p", identity_key: "p", strategy: "sd_reversal", direction: dir, timeframe: "M15", confirm_tf: "M15", entry_type: "limit",
      entry_price: price - s * 50, entry_low: price - s * 52, entry_high: price - s * 50, invalidation: price - s * 60, sl: price - s * 55,
      created_at_sec: t - 600, expires_at_sec: t + 7200, status: "approaching", eligible: true, confirmed_at_sec: null, entry_touched_at_sec: null,
    };
    const running: StoredSetup = { ...base, id: "r", identity_key: "r", status: "entry_touched", entry_touched_at_sec: t - 3600, outcome: "open", outcome_tp: 0 };
    const out = runEngineCycle(input(t, { config: cfg, existing: [base, running] }));
    expect(out.created).toEqual([]);
    expect(out.changes.find((c) => c.id === "p")).toMatchObject({ to: "expired", events: ["expired"] });
    expect(out.changes.find((c) => c.id === "r")).toMatchObject({ to: "entry_touched", events: [] });
    const recap = out.notifications.find((n) => n.dedupeKey === "recap:2026-07-14");
    expect(recap?.title).toMatch(/^📊 REKAP 14 Jul — 1 entry · 0W\/0L/);
    expect(recap?.body).toMatch(/1 masih berjalan/);
    expect(out.analysis.reasons[0]).toMatch(/^Jam istirahat 23.10–05.00 WIB/);
  });
});
