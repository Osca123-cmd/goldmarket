import { initialRisk, realizedPnl, rMultiple, type JournalPartial, type JournalTrade } from "./journal.ts";
import { ymd } from "./time.ts";

/**
 * Statistik dari jurnal AKTUAL.
 * - Hanya transaksi status "closed" yang dihitung; "open" dilaporkan terpisah, "cancelled" diabaikan.
 * - Satu transaksi = satu hasil, apa pun milestone TP yang ditandai (tidak ada penggandaan kemenangan).
 * - Partial close dijumlahkan ke hasil transaksi induknya.
 * - Net = PnL terealisasi − komisi − swap.
 * - BE: |R| < beThresholdR (default 0.05R) ATAU outcome "be" dengan |R| < 0.2 → tidak masuk win/loss.
 * - Win rate = menang / (menang + kalah).
 */
export interface TradeResult {
  trade: JournalTrade;
  net: number;
  gross: number;
  fees: number;
  r: number | null;
  risk: number;
  kind: "win" | "loss" | "be";
}

export interface GroupStats {
  key: string;
  trades: number;
  wins: number;
  losses: number;
  be: number;
  winRate: number | null;
  net: number;
  avgR: number | null;
}

export interface Stats {
  closed: number;
  open: number;
  cancelled: number;
  wins: number;
  losses: number;
  be: number;
  winRate: number | null;
  net: number;
  grossProfit: number;
  grossLoss: number;
  totalFees: number;
  profitFactor: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  avgR: number | null;
  totalR: number;
  maxDrawdown: number;
  maxDrawdownR: number;
  maxDrawdownPct: number | null;
  equity: { time: string; equity: number }[];
  byStrategy: GroupStats[];
  bySession: GroupStats[];
  byTimeframe: GroupStats[];
  calendar: Record<string, { net: number; trades: number }>;
  warnings: string[];
  results: TradeResult[];
}

export function classify(net: number, r: number | null, outcome: JournalTrade["outcome"], beThresholdR = 0.05): TradeResult["kind"] {
  if (r != null && Math.abs(r) < beThresholdR) return "be";
  if (outcome === "be" && r != null && Math.abs(r) < 0.2) return "be";
  if (r == null && Math.abs(net) < 1e-9) return "be";
  return net > 0 ? "win" : "loss";
}

function group(results: TradeResult[], keyOf: (t: JournalTrade) => string): GroupStats[] {
  const map = new Map<string, TradeResult[]>();
  for (const r of results) {
    const k = keyOf(r.trade) || "—";
    map.set(k, [...(map.get(k) ?? []), r]);
  }
  return [...map.entries()]
    .map(([key, rs]) => {
      const wins = rs.filter((x) => x.kind === "win").length;
      const losses = rs.filter((x) => x.kind === "loss").length;
      const rr = rs.map((x) => x.r).filter((x): x is number => x != null);
      return {
        key,
        trades: rs.length,
        wins,
        losses,
        be: rs.length - wins - losses,
        winRate: wins + losses > 0 ? wins / (wins + losses) : null,
        net: rs.reduce((a, x) => a + x.net, 0),
        avgR: rr.length ? rr.reduce((a, b) => a + b, 0) / rr.length : null,
      };
    })
    .sort((a, b) => b.trades - a.trades);
}

export function computeStats(
  trades: JournalTrade[],
  partials: JournalPartial[],
  opts: { tz: string; startingBalance?: number | null; beThresholdR?: number } = { tz: "Asia/Jakarta" },
): Stats {
  const warnings: string[] = [];
  const closed = trades.filter((t) => t.status === "closed");
  const results: TradeResult[] = closed
    .map((t) => {
      const own = partials.filter((p) => p.trade_id === t.id);
      const { gross, fees, net } = realizedPnl(t, own);
      const r = rMultiple(t, net);
      if (own.length === 0) warnings.push(`Transaksi ${t.id.slice(0, 8)} ditutup tanpa harga keluar tercatat.`);
      return { trade: t, net, gross, fees, r, risk: initialRisk(t), kind: classify(net, r, t.outcome, opts.beThresholdR) };
    })
    .sort((a, b) => (a.trade.closed_at ?? "").localeCompare(b.trade.closed_at ?? ""));

  const wins = results.filter((r) => r.kind === "win");
  const losses = results.filter((r) => r.kind === "loss");
  const grossProfit = wins.reduce((a, r) => a + r.net, 0);
  const grossLoss = losses.reduce((a, r) => a + r.net, 0);
  const rs = results.map((r) => r.r).filter((x): x is number => x != null);

  let eq = 0;
  let peak = 0;
  let mdd = 0;
  let eqR = 0;
  let peakR = 0;
  let mddR = 0;
  let peakAbs = opts.startingBalance ?? 0;
  let mddPct = 0;
  const equity: Stats["equity"] = [];
  for (const r of results) {
    eq += r.net;
    peak = Math.max(peak, eq);
    mdd = Math.max(mdd, peak - eq);
    eqR += r.r ?? 0;
    peakR = Math.max(peakR, eqR);
    mddR = Math.max(mddR, peakR - eqR);
    if (opts.startingBalance) {
      const bal = opts.startingBalance + eq;
      peakAbs = Math.max(peakAbs, bal);
      mddPct = Math.max(mddPct, (peakAbs - bal) / peakAbs);
    }
    equity.push({ time: r.trade.closed_at ?? "", equity: eq });
  }

  const calendar: Stats["calendar"] = {};
  for (const r of results) {
    if (!r.trade.closed_at) continue;
    const d = ymd(Date.parse(r.trade.closed_at), opts.tz);
    calendar[d] = { net: (calendar[d]?.net ?? 0) + r.net, trades: (calendar[d]?.trades ?? 0) + 1 };
  }

  if (results.length === 0) warnings.push("Belum ada transaksi tertutup — statistik belum dapat dihitung.");
  else if (results.length < 30) warnings.push(`Sampel kecil (${results.length} transaksi tertutup); statistik belum stabil.`);
  if (results.some((r) => r.r == null)) warnings.push("Sebagian transaksi tanpa SL awal valid sehingga R tidak dapat dihitung.");

  return {
    closed: results.length,
    open: trades.filter((t) => t.status === "open").length,
    cancelled: trades.filter((t) => t.status === "cancelled").length,
    wins: wins.length,
    losses: losses.length,
    be: results.length - wins.length - losses.length,
    winRate: wins.length + losses.length > 0 ? wins.length / (wins.length + losses.length) : null,
    net: results.reduce((a, r) => a + r.net, 0),
    grossProfit,
    grossLoss,
    totalFees: results.reduce((a, r) => a + r.fees, 0),
    profitFactor: grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : null,
    avgWin: wins.length ? grossProfit / wins.length : null,
    avgLoss: losses.length ? grossLoss / losses.length : null,
    avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
    totalR: rs.reduce((a, b) => a + b, 0),
    maxDrawdown: mdd,
    maxDrawdownR: mddR,
    maxDrawdownPct: opts.startingBalance ? mddPct : null,
    equity,
    byStrategy: group(results, (t) => t.strategy),
    bySession: group(results, (t) => t.session),
    byTimeframe: group(results, (t) => t.timeframe),
    calendar,
    warnings,
    results,
  };
}

function csvCell(v: unknown): string {
  if (v == null) return "";
  let s = String(v);
  // cegah CSV/formula injection di spreadsheet
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function tradesToCsv(trades: JournalTrade[], partials: JournalPartial[]): string {
  const header = [
    "id", "opened_at", "closed_at", "status", "outcome", "direction", "strategy", "timeframe", "session",
    "entry", "lot", "initial_sl", "sl", "tp1", "tp2", "tp3", "tp1_hit_at", "tp2_hit_at", "tp3_hit_at",
    "commission", "swap", "gross_pnl", "net_pnl", "r_multiple", "notes",
  ];
  const rows = trades.map((t) => {
    const own = partials.filter((p) => p.trade_id === t.id);
    const { gross, net } = realizedPnl(t, own);
    const r = t.status === "closed" ? rMultiple(t, net) : null;
    return [
      t.id, t.opened_at, t.closed_at, t.status, t.outcome, t.direction, t.strategy, t.timeframe, t.session,
      t.entry_price, t.lot, t.initial_sl, t.sl, t.tp1, t.tp2, t.tp3, t.tp1_hit_at, t.tp2_hit_at, t.tp3_hit_at,
      t.commission, t.swap, gross.toFixed(2), net.toFixed(2), r == null ? "" : r.toFixed(2), t.notes,
    ].map(csvCell).join(",");
  });
  return [header.join(","), ...rows].join("\n");
}
