"use client";

import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/Shell";
import { Card, Disclaimer, Empty, Stat, cx, fmt, fmtMoney } from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/lib/supabase";
import { computeStats, tradesToCsv, type GroupStats } from "@/core/stats";
import type { JournalPartial, JournalTrade } from "@/core/journal";
import { STRATEGY_LABEL } from "@/core/config";

export default function Page() {
  return (
    <AppShell>
      <StatsPage />
    </AppShell>
  );
}

const NUM = ["entry_price", "lot", "initial_sl", "sl", "tp1", "tp2", "tp3", "commission", "swap", "contract_size", "quote_to_account_rate"];

function StatsPage() {
  const { settings, session } = useAuth();
  const [trades, setTrades] = useState<JournalTrade[]>([]);
  const [partials, setPartials] = useState<JournalPartial[]>([]);
  const [loading, setLoading] = useState(true);
  const tz = settings?.display_tz ?? "Asia/Jakarta";
  const ccy = settings?.account_currency ?? "USD";

  useEffect(() => {
    if (!session) return;
    const sb = supabase();
    Promise.all([sb.from("journal_trades").select("*").limit(5000), sb.from("journal_partials").select("*").limit(20000)]).then(([t, p]) => {
      setTrades((t.data ?? []).map((r) => {
        const o = { ...r } as Record<string, unknown>;
        for (const k of NUM) o[k] = o[k] == null ? null : Number(o[k]);
        return o as unknown as JournalTrade;
      }));
      setPartials((p.data ?? []).map((r) => ({ ...r, lot: Number(r.lot), price: Number(r.price) })) as JournalPartial[]);
      setLoading(false);
    });
  }, [session]);

  const s = useMemo(() => computeStats(trades, partials, { tz, startingBalance: settings?.starting_balance ?? null }), [trades, partials, tz, settings?.starting_balance]);

  const exportCsv = () => {
    const blob = new Blob(["﻿" + tradesToCsv(trades, partials)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `goldmarket-jurnal-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (loading) return <p className="text-sm text-muted">Memuat statistik…</p>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="mr-auto">
          <h1 className="text-xl font-bold">Statistik</h1>
          <p className="text-sm text-muted">Dihitung hanya dari jurnal aktual Anda — tanpa angka simulasi.</p>
        </div>
        <button className="btn-ghost" onClick={exportCsv} disabled={trades.length === 0}>
          Ekspor CSV
        </button>
      </div>

      {s.warnings.length > 0 && (
        <ul className="space-y-1 rounded-xl border border-warn/40 bg-warn/5 p-3 text-xs text-warn">
          {s.warnings.map((w, i) => (
            <li key={i}>• {w}</li>
          ))}
        </ul>
      )}

      {s.closed === 0 ? (
        <Empty title="Data belum cukup">Belum ada transaksi tertutup. Transaksi terbuka: {s.open}. Statistik akan muncul setelah Anda menutup transaksi di jurnal.</Empty>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Transaksi tertutup" value={s.closed} sub={`${s.open} terbuka · ${s.cancelled} batal`} />
            <Stat label="Win rate" value={s.winRate == null ? "—" : `${fmt(s.winRate * 100, 1)}%`} sub={`${s.wins}M / ${s.losses}K / ${s.be} BE`} />
            <Stat label="Net P/L" value={fmtMoney(s.net, ccy)} tone={s.net >= 0 ? "buy" : "sell"} sub={`biaya ${fmtMoney(s.totalFees, ccy)}`} />
            <Stat label="Profit factor" value={s.profitFactor == null ? "—" : fmt(s.profitFactor)} />
            <Stat label="Avg win / loss" value={`${fmtMoney(s.avgWin, ccy)} / ${fmtMoney(s.avgLoss, ccy)}`} />
            <Stat label="Rata-rata R" value={s.avgR == null ? "—" : `${fmt(s.avgR)}R`} sub={`total ${fmt(s.totalR)}R`} />
            <Stat label="Max drawdown" value={fmtMoney(-s.maxDrawdown, ccy)} tone="sell" sub={`${fmt(s.maxDrawdownR)}R${s.maxDrawdownPct != null ? ` · ${fmt(s.maxDrawdownPct * 100, 1)}%` : ""}`} />
          </div>

          <Card title="Kurva ekuitas (transaksi tertutup)">
            <Equity points={s.equity.map((e) => e.equity)} />
          </Card>

          <div className="grid gap-4 lg:grid-cols-3">
            <GroupTable title="Per strategi" rows={s.byStrategy} ccy={ccy} label={(k) => STRATEGY_LABEL[k as keyof typeof STRATEGY_LABEL] ?? k} />
            <GroupTable title="Per sesi" rows={s.bySession} ccy={ccy} />
            <GroupTable title="Per timeframe" rows={s.byTimeframe} ccy={ccy} />
          </div>

          <Card title="Kalender hasil">
            <Calendar data={s.calendar} ccy={ccy} />
          </Card>
        </>
      )}

      <Card title="Metode perhitungan">
        <ul className="list-disc space-y-1 pl-4 text-xs text-muted">
          <li>Hanya transaksi berstatus selesai yang dihitung. Transaksi terbuka ditampilkan terpisah (tanpa P/L belum terealisasi); transaksi dibatalkan diabaikan.</li>
          <li>Satu transaksi = satu hasil. Milestone TP1/TP2/TP3 tidak dihitung sebagai kemenangan terpisah.</li>
          <li>Partial close dijumlahkan ke transaksi induknya. Net = Σ P/L partial − komisi − swap.</li>
          <li>R-multiple = net ÷ risiko awal (|entry − SL awal| × contract size × lot × kurs). Memindah SL ke BE tidak mengubah 1R.</li>
          <li>BE: |R| &lt; 0,05 (atau outcome BE dengan |R| &lt; 0,2) — tidak masuk menang/kalah. Win rate = menang ÷ (menang + kalah).</li>
          <li>Drawdown = penurunan terbesar dari puncak kurva ekuitas transaksi tertutup (urut waktu tutup). Persentase memakai saldo awal di Pengaturan bila diisi.</li>
          <li>Kalender memakai tanggal tutup di zona {tz}.</li>
        </ul>
      </Card>
      <Disclaimer />
    </div>
  );
}

function GroupTable({ title, rows, ccy, label }: { title: string; rows: GroupStats[]; ccy: string; label?: (k: string) => string }) {
  return (
    <Card title={title}>
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Grup</th>
              <th>N</th>
              <th>Win%</th>
              <th>Net</th>
              <th>Avg R</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td>{label ? label(r.key) : r.key}</td>
                <td className="num">{r.trades}</td>
                <td className="num">{r.winRate == null ? "—" : fmt(r.winRate * 100, 0)}</td>
                <td className={cx("num", r.net >= 0 ? "text-buy" : "text-sell")}>{fmtMoney(r.net, ccy)}</td>
                <td className="num">{r.avgR == null ? "—" : fmt(r.avgR)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Equity({ points }: { points: number[] }) {
  if (points.length < 2) return <p className="text-xs text-muted">Butuh minimal 2 transaksi tertutup.</p>;
  const pts = [0, ...points];
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const w = 800;
  const h = 200;
  const x = (i: number) => (i / (pts.length - 1)) * w;
  const y = (v: number) => h - ((v - min) / (max - min || 1)) * (h - 10) - 5;
  const d = pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-48 w-full" preserveAspectRatio="none" role="img" aria-label="Kurva ekuitas">
      <line x1="0" x2={w} y1={y(0)} y2={y(0)} stroke="#243047" strokeDasharray="4 4" />
      <path d={d} fill="none" stroke="#d6b25e" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Calendar({ data, ccy }: { data: Record<string, { net: number; trades: number }>; ccy: string }) {
  const months = useMemo(() => [...new Set(Object.keys(data).map((d) => d.slice(0, 7)))].sort().reverse(), [data]);
  const [m, setM] = useState(months[0]);
  if (!m) return null;
  const [yy, mm] = m.split("-").map(Number);
  const first = new Date(Date.UTC(yy, mm - 1, 1)).getUTCDay();
  const days = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const cells = Array.from({ length: (first + 6) % 7 }, () => null as number | null).concat(Array.from({ length: days }, (_, i) => i + 1));
  return (
    <div>
      <select className="input mb-3 w-40" value={m} onChange={(e) => setM(e.target.value)} aria-label="Bulan">
        {months.map((x) => (
          <option key={x}>{x}</option>
        ))}
      </select>
      <div className="grid grid-cols-7 gap-1 text-center text-[10px] text-muted">
        {["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"].map((d) => (
          <div key={d}>{d}</div>
        ))}
        {cells.map((d, i) => {
          if (d == null) return <div key={i} />;
          const key = `${m}-${String(d).padStart(2, "0")}`;
          const v = data[key];
          return (
            <div key={i} className={cx("min-h-14 rounded-lg border p-1 text-left", v ? (v.net > 0 ? "border-buy/40 bg-buy/10" : v.net < 0 ? "border-sell/40 bg-sell/10" : "border-line") : "border-line/40")}>
              <div className="text-muted">{d}</div>
              {v && (
                <div className={cx("num truncate text-[10px]", v.net >= 0 ? "text-buy" : "text-sell")} title={`${v.trades} transaksi`}>
                  {fmtMoney(v.net, ccy)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
