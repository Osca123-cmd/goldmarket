import { describe, expect, it } from "vitest";
import { computeSignalStats, type SignalResultRow } from "../src/core/signalStats.ts";

const row = (o: Partial<SignalResultRow>): SignalResultRow => ({
  direction: "SELL", timeframe: "M15", strategy: "sd_reversal", status: "entry_touched",
  outcome: "win", outcome_pips: 50, outcome_tp: 1, outcome_at: "2026-10-19T05:00:00Z", entry_touched_at: "2026-10-19T04:00:00Z", ...o,
});

describe("statistik sinyal otomatis", () => {
  const rows = [
    row({ outcome: "loss", outcome_pips: -50, outcome_tp: 0, direction: "BUY", outcome_at: "2026-10-19T05:19:00Z" }),
    row({ outcome: "win", outcome_pips: 100, outcome_tp: 2, outcome_at: "2026-10-19T05:40:00Z" }),
    row({ outcome: "win", outcome_pips: 140, outcome_tp: 2, timeframe: "M30", outcome_at: "2026-10-19T06:55:00Z" }),
    row({ outcome: "loss", outcome_pips: -50, outcome_tp: 0, outcome_at: "2026-10-20T01:00:00Z" }),
    row({ outcome: "loss", outcome_pips: -50, outcome_tp: 0, outcome_at: "2026-10-20T02:00:00Z" }),
    row({ outcome: "timeout", outcome_pips: 12, outcome_tp: 0, outcome_at: "2026-10-20T03:00:00Z" }),
    row({ outcome: "open", outcome_pips: null, outcome_tp: 1, outcome_at: null }),
    row({ outcome: "loss", outcome_pips: -70, outcome_tp: 0, timeframe: "M30", excluded: true, outcome_at: "2026-10-19T09:00:00Z" }),
  ];
  const s = computeSignalStats(rows, "Asia/Jakarta");

  it("menghitung win rate tanpa timeout dan memisahkan sinyal berjalan", () => {
    expect(s).toMatchObject({ closed: 6, running: 1, excluded: 1, wins: 2, losses: 3, timeouts: 1, winRate: 0.4 });
  });
  it("total, rata-rata, profit factor, drawdown, dan runtun kalah", () => {
    expect(s.totalPips).toBe(102);
    expect(s.avgWin).toBe(120);
    expect(s.avgLoss).toBe(-50);
    expect(s.profitFactor).toBeCloseTo(252 / 150);
    expect(s.maxDrawdownPips).toBe(100);
    expect(s.maxLossStreak).toBe(2);
    expect(s.tpReach).toEqual([2, 2, 0]);
  });
  it("kelompok per TF/arah dan kalender per zona waktu", () => {
    expect(s.byTimeframe.find((g) => g.key === "M30")).toMatchObject({ signals: 1, wins: 1, pips: 140 });
    expect(s.byDirection.find((g) => g.key === "BUY")).toMatchObject({ signals: 1, losses: 1, winRate: 0 });
    expect(s.calendar["2026-10-19"]).toEqual({ net: 190, trades: 3 });
    expect(s.calendar["2026-10-20"]).toEqual({ net: -88, trades: 3 });
  });
});
