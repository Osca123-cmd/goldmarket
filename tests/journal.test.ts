import { describe, expect, it } from "vitest";
import { computeStats, tradesToCsv } from "../src/core/stats.ts";
import { realizedPnl, tp1ReachedByFeed, validateAction, type JournalPartial, type JournalTrade } from "../src/core/journal.ts";
import { runEngineCycle } from "../src/core/engine.ts";
import { DEFAULT_ENGINE_CONFIG } from "../src/core/config.ts";

const trade = (over: Partial<JournalTrade>): JournalTrade => ({
  id: "t-" + Math.random().toString(36).slice(2),
  setup_id: null, direction: "BUY", strategy: "trend_pullback", timeframe: "M15", session: "london",
  entry_price: 3000, lot: 0.1, initial_sl: 2995, sl: 2995, tp1: 3005, tp2: 3010, tp3: 3015,
  opened_at: "2026-07-14T08:00:00Z", closed_at: null, status: "open", outcome: null,
  tp1_hit_at: null, tp2_hit_at: null, tp3_hit_at: null, commission: 0, swap: 0,
  contract_size: 100, quote_to_account_rate: 1, notes: null, ...over,
});
const part = (t: JournalTrade, lot: number, price: number, kind: "partial" | "final" = "final", at = "2026-07-14T10:00:00Z"): JournalPartial => ({ id: Math.random().toString(), trade_id: t.id, closed_at: at, lot, price, kind });

describe("jurnal", () => {
  it("PnL terealisasi = Σ partial − biaya", () => {
    const t = trade({ commission: 7, status: "closed", closed_at: "2026-07-14T10:00:00Z" });
    const ps = [part(t, 0.05, 3005, "partial"), part(t, 0.05, 3010)];
    expect(realizedPnl(t, ps)).toEqual({ gross: 75, fees: 7, net: 68 });
  });

  it("harga live tidak mengubah jurnal: pengingat TP1 tidak memodifikasi transaksi", () => {
    const t = Object.freeze(trade({}));
    expect(tp1ReachedByFeed(t, 3006)).toBe(true); // hanya pengingat
    expect(t.sl).toBe(2995);
    expect(t.status).toBe("open");
    // engine tidak menerima atau mengembalikan data jurnal sama sekali
    const keys = Object.keys(runEngineCycle({
      nowSec: 0, rawCandles: {}, price: 3006, quoteTimeSec: 0, spreadPips: 3, assumedSpreadPips: 3,
      feedStatus: "live", previousFeedStatus: "live", existing: [],
      config: DEFAULT_ENGINE_CONFIG,
    }));
    expect(keys.some((k) => /journal/i.test(k))).toBe(false);
  });

  it("validasi aksi: partial tidak boleh ≥ sisa lot, transaksi tertutup tidak bisa diubah", () => {
    const t = trade({});
    expect(validateAction(t, [], { type: "partial", lot: 0.1, price: 3005 })).toMatch(/sisa lot/);
    expect(validateAction(t, [], { type: "partial", lot: 0.05, price: 3005 })).toBeNull();
    expect(validateAction({ ...t, status: "closed" }, [], { type: "move_sl", sl: 3000 })).toMatch(/tidak terbuka/);
    expect(validateAction({ ...t, tp1_hit_at: "x" }, [], { type: "milestone", milestone: "tp1" })).toMatch(/sudah/);
  });
});

describe("statistik", () => {
  it("milestone TP tidak menggandakan kemenangan: 1 transaksi = 1 hasil", () => {
    const t = trade({ status: "closed", outcome: "tp3", tp1_hit_at: "a", tp2_hit_at: "b", tp3_hit_at: "c", closed_at: "2026-07-14T12:00:00Z" });
    const ps = [part(t, 0.03, 3005, "partial"), part(t, 0.03, 3010, "partial"), part(t, 0.04, 3015)];
    const s = computeStats([t], ps, { tz: "Asia/Jakarta" });
    expect(s.closed).toBe(1);
    expect(s.wins).toBe(1);
    expect(s.net).toBeCloseTo(15 + 30 + 60);
    expect(s.results[0].r).toBeCloseTo(105 / 50);
  });

  it("win rate, profit factor, BE, drawdown, transaksi terbuka dipisah", () => {
    const w = trade({ status: "closed", closed_at: "2026-07-14T10:00:00Z" });
    const l = trade({ status: "closed", closed_at: "2026-07-14T11:00:00Z" });
    const l2 = trade({ status: "closed", closed_at: "2026-07-15T11:00:00Z" });
    const be = trade({ status: "closed", outcome: "be", sl: 3000, closed_at: "2026-07-15T12:00:00Z" });
    const open = trade({});
    const cancelled = trade({ status: "cancelled" });
    const ps = [part(w, 0.1, 3010), part(l, 0.1, 2995), part(l2, 0.1, 2995), part(be, 0.1, 3000)];
    const s = computeStats([w, l, l2, be, open, cancelled], ps, { tz: "Asia/Jakarta", startingBalance: 1000 });
    expect([s.wins, s.losses, s.be, s.open, s.cancelled]).toEqual([1, 2, 1, 1, 1]);
    expect(s.winRate).toBeCloseTo(1 / 3);
    expect(s.net).toBeCloseTo(100 - 50 - 50);
    expect(s.profitFactor).toBeCloseTo(1);
    expect(s.maxDrawdown).toBeCloseTo(100);
    expect(s.maxDrawdownR).toBeCloseTo(2);
    expect(s.maxDrawdownPct).toBeCloseTo(100 / 1100);
    expect(Object.keys(s.calendar)).toEqual(["2026-07-14", "2026-07-15"]);
    expect(s.warnings.join()).toMatch(/Sampel kecil/);
  });

  it("tanpa data → tidak ada angka karangan", () => {
    const s = computeStats([], [], { tz: "UTC" });
    expect(s.winRate).toBeNull();
    expect(s.profitFactor).toBeNull();
    expect(s.warnings[0]).toMatch(/Belum ada transaksi/);
  });

  it("ekspor CSV aman dari formula injection", () => {
    const t = trade({ notes: "=HYPERLINK(\"x\")" });
    const csv = tradesToCsv([t], []);
    expect(csv.split("\n")).toHaveLength(2);
    expect(csv).toContain("'=HYPERLINK");
  });
});
