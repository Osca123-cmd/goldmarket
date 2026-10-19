import { ymd } from "./time.ts";

/**
 * Statistik OTOMATIS dari hasil sinyal engine (Riwayat Sinyal) — terpisah dari jurnal aktual.
 * - Selesai = WIN / LOSS / TIMEOUT; sinyal berjalan dilaporkan terpisah.
 * - Satu sinyal = satu hasil (pips TP tertinggi bila WIN, −SL bila LOSS, harga terakhir bila TIMEOUT).
 * - Win rate = WIN ÷ (WIN + LOSS); TIMEOUT tidak masuk menang/kalah tetapi pips-nya ikut dijumlah.
 * - Pips level sinyal menurut feed, tanpa spread/komisi — bukan transaksi pengguna.
 * - Sinyal yang DIKECUALIKAN pengguna tidak dihitung (jumlahnya dilaporkan terpisah).
 */
export interface SignalResultRow {
  direction: "BUY" | "SELL";
  timeframe: string;
  strategy: string;
  status: string;
  outcome: string | null;
  outcome_pips: number | null;
  outcome_tp: number | null;
  outcome_at: string | null;
  entry_touched_at: string | null;
  excluded?: boolean;
}

export interface SignalGroup {
  key: string;
  signals: number;
  wins: number;
  losses: number;
  winRate: number | null;
  pips: number;
}

export interface SignalStats {
  closed: number;
  running: number;
  /** sinyal selesai yang dikecualikan pengguna (tidak masuk angka mana pun) */
  excluded: number;
  wins: number;
  losses: number;
  timeouts: number;
  winRate: number | null;
  totalPips: number;
  avgPips: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  profitFactor: number | null;
  maxDrawdownPips: number;
  maxLossStreak: number;
  /** jumlah WIN yang mencapai minimal TP1 / TP2 / TP3 */
  tpReach: [number, number, number];
  equity: { time: string; pips: number }[];
  byTimeframe: SignalGroup[];
  byStrategy: SignalGroup[];
  byDirection: SignalGroup[];
  calendar: Record<string, { net: number; trades: number }>;
}

const CLOSED = new Set(["win", "loss", "timeout"]);

function group(rows: SignalResultRow[], keyOf: (r: SignalResultRow) => string): SignalGroup[] {
  const m = new Map<string, SignalGroup>();
  for (const r of rows) {
    const k = keyOf(r);
    const g = m.get(k) ?? { key: k, signals: 0, wins: 0, losses: 0, winRate: null, pips: 0 };
    g.signals++;
    if (r.outcome === "win") g.wins++;
    if (r.outcome === "loss") g.losses++;
    g.pips += r.outcome_pips ?? 0;
    m.set(k, g);
  }
  return [...m.values()].map((g) => ({ ...g, winRate: g.wins + g.losses ? g.wins / (g.wins + g.losses) : null })).sort((a, b) => b.signals - a.signals);
}

export function computeSignalStats(rows: SignalResultRow[], tz: string): SignalStats {
  const running = rows.filter((r) => r.status === "entry_touched" && (r.outcome == null || r.outcome === "open")).length;
  const done = rows.filter((r) => r.outcome != null && CLOSED.has(r.outcome));
  const closed = done
    .filter((r) => !r.excluded)
    .sort((a, b) => Date.parse(a.outcome_at ?? a.entry_touched_at ?? "") - Date.parse(b.outcome_at ?? b.entry_touched_at ?? ""));
  const wins = closed.filter((r) => r.outcome === "win");
  const losses = closed.filter((r) => r.outcome === "loss");
  const pips = (r: SignalResultRow) => r.outcome_pips ?? 0;
  const sum = (xs: SignalResultRow[]) => xs.reduce((a, r) => a + pips(r), 0);
  const grossWin = closed.filter((r) => pips(r) > 0).reduce((a, r) => a + pips(r), 0);
  const grossLoss = -closed.filter((r) => pips(r) < 0).reduce((a, r) => a + pips(r), 0);

  let eq = 0;
  let peak = 0;
  let mdd = 0;
  let streak = 0;
  let maxStreak = 0;
  const equity: SignalStats["equity"] = [];
  const calendar: SignalStats["calendar"] = {};
  for (const r of closed) {
    eq += pips(r);
    peak = Math.max(peak, eq);
    mdd = Math.max(mdd, peak - eq);
    streak = r.outcome === "loss" ? streak + 1 : r.outcome === "win" ? 0 : streak;
    maxStreak = Math.max(maxStreak, streak);
    const at = r.outcome_at ?? r.entry_touched_at;
    equity.push({ time: at ?? "", pips: eq });
    if (at) {
      const d = ymd(Date.parse(at), tz);
      calendar[d] = { net: (calendar[d]?.net ?? 0) + pips(r), trades: (calendar[d]?.trades ?? 0) + 1 };
    }
  }

  return {
    closed: closed.length,
    running,
    excluded: done.length - closed.length,
    wins: wins.length,
    losses: losses.length,
    timeouts: closed.length - wins.length - losses.length,
    winRate: wins.length + losses.length ? wins.length / (wins.length + losses.length) : null,
    totalPips: sum(closed),
    avgPips: closed.length ? sum(closed) / closed.length : null,
    avgWin: wins.length ? sum(wins) / wins.length : null,
    avgLoss: losses.length ? sum(losses) / losses.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    maxDrawdownPips: mdd,
    maxLossStreak: maxStreak,
    tpReach: [1, 2, 3].map((k) => wins.filter((r) => (r.outcome_tp ?? 0) >= k).length) as [number, number, number],
    equity,
    byTimeframe: group(closed, (r) => r.timeframe),
    byStrategy: group(closed, (r) => r.strategy),
    byDirection: group(closed, (r) => r.direction),
    calendar,
  };
}
