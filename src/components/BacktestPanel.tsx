"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { MGMT_LABEL, MGMT_VARIANTS, pickVariant, type BtGroupStats, type MgmtVariant, type StrategyReport, type VariantStats } from "@/core/backtest";
import { STRATEGY_LABEL } from "@/core/config";
import { Card, Empty, cx, fmt } from "./ui";

interface ReportRow {
  version: string;
  computed_at: string;
  source: string;
  chunks: number;
  report: StrategyReport;
}

const SESSION_LABEL: Record<string, string> = { asia: "Asia (Tokyo)", london: "London", newyork: "New York", off: "Di luar sesi utama" };
const TARGET_CHUNKS = 52; // ±12 bulan potongan 7 hari
const TARGET_WR = 0.75;

function groupLabel(key: string): string {
  if (key === "all") return "Semua setup";
  const [kind, val] = key.split(":");
  if (kind === "strategy") {
    const [st, tf] = val.split("|");
    return `${STRATEGY_LABEL[st as keyof typeof STRATEGY_LABEL] ?? st} · ${tf}`;
  }
  if (kind === "session") return `Sesi ${SESSION_LABEL[val] ?? val}`;
  if (kind === "direction") return val;
  return key;
}

const pct = (p: number | null | undefined) => (p == null ? "—" : `${fmt(p * 100, 0)}%`);
const signed = (x: number | null | undefined, d = 1) => (x == null ? "—" : `${x > 0 ? "+" : ""}${fmt(x, d)}`);

/** Kalimat rekomendasi berbasis data uji — bukan perintah, dan jujur bila belum terbukti. */
function recommendation(all: BtGroupStats | undefined, minSamples: number): { tone: "buy" | "warn" | "sell"; text: string } {
  if (!all) return { tone: "warn", text: "Belum ada data uji." };
  const ranked = MGMT_VARIANTS.map((v) => ({ v, s: all.variants[v] })).sort((a, b) => (b.s.expPips ?? -Infinity) - (a.s.expPips ?? -Infinity));
  const best = ranked[0];
  if (best.s.n < minSamples) return { tone: "warn", text: `Sampel uji belum memadai (n=${best.s.n} < ${minSamples}). Hasil di bawah belum bisa dijadikan pegangan — tunggu pengisian data selesai.` };
  if ((best.s.expPips ?? 0) <= 0) return { tone: "sell", text: "Belum ada varian manajemen yang positif pada data uji. Artinya strategi belum terbukti memiliki edge setelah biaya — perlakukan setiap sinyal dengan sangat hati-hati dan risiko kecil." };
  if ((best.s.expLo ?? 0) > 0)
    return { tone: "buy", text: `Varian ${best.v} (“${MGMT_LABEL[best.v]}”) memberi ekspektasi tertinggi pada data uji: ${signed(best.s.expPips)} pips/trade (interval ${signed(best.s.expLo)}…${signed(best.s.expHi)}), dan intervalnya di atas nol. Ini hasil historis, bukan jaminan.` };
  return { tone: "warn", text: `Varian ${best.v} (“${MGMT_LABEL[best.v]}”) paling baik pada data uji (${signed(best.s.expPips)} pips/trade), tetapi interval ketidakpastiannya masih mencakup nol (${signed(best.s.expLo)}…${signed(best.s.expHi)}) — belum terbukti secara statistik.` };
}

function VariantCard({ v, s, best }: { v: MgmtVariant; s: VariantStats; best: boolean }) {
  const pos = (s.expPips ?? 0) > 0;
  return (
    <div className={cx("min-w-0 rounded-2xl border p-4", best ? "border-gold/50 bg-gold/5" : "border-blue/20 bg-[#0a1435]/70")}>
      <div className="flex items-center gap-2">
        <span className={cx("grid h-7 w-7 shrink-0 place-items-center rounded-lg text-sm font-extrabold", best ? "bg-gold text-bg" : "bg-blue/20 text-blue-strong")}>{v}</span>
        <span className="min-w-0 flex-1 text-sm font-semibold">{MGMT_LABEL[v]}</span>
        <span className={cx("num shrink-0 rounded-lg px-2 py-0.5 text-sm font-bold", (s.winRate.p ?? 0) >= TARGET_WR ? "bg-buy/15 text-buy" : "bg-surface-2 text-ink")} title="Win rate (trade dengan P/L > 0)">
          WR {pct(s.winRate.p)}
        </span>
      </div>
      <div className={cx("num mt-3 text-2xl font-bold", s.expPips == null ? "text-muted" : pos ? "text-buy" : "text-sell")}>
        {signed(s.expPips)} <span className="text-sm font-medium text-muted">pips/trade</span>
      </div>
      <div className="num text-[11px] text-muted">
        interval {signed(s.expLo)} … {signed(s.expHi)} · {signed(s.expR, 2)} R
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted">Trade (n)</dt>
        <dd className="num text-right">{s.n}</dd>
        <dt className="text-muted">Win rate</dt>
        <dd className="num text-right">{pct(s.winRate.p)}</dd>
        <dt className="text-muted">Profit factor</dt>
        <dd className="num text-right">{s.profitFactor == null ? "—" : fmt(s.profitFactor, 2)}</dd>
        <dt className="text-muted">Total</dt>
        <dd className={cx("num text-right", s.totalPips >= 0 ? "text-buy" : "text-sell")}>{signed(s.totalPips)} pips</dd>
        <dt className="text-muted">Max drawdown</dt>
        <dd className="num text-right text-sell">−{fmt(s.maxDrawdownPips, 1)} pips</dd>
      </dl>
    </div>
  );
}

/** Target win rate tinggi: varian dipilih dari data pengembangan, dibuktikan di data uji. */
function TargetWinRate({ report }: { report: StrategyReport }) {
  const pick = pickVariant(report, TARGET_WR);
  if (!pick) return null;
  const label = `Varian ${pick.variant} (“${MGMT_LABEL[pick.variant]}”)`;
  const dev = `WR ${pct(pick.dev.winRate.p)}, ${signed(pick.dev.expPips)} pips/trade`;
  const test = pick.test ? `WR ${pct(pick.test.winRate.p)}, ${signed(pick.test.expPips)} pips/trade (interval ${signed(pick.test.expLo)}…${signed(pick.test.expHi)}, n=${pick.test.n})` : "—";
  let tone: "buy" | "warn" | "sell" = "warn";
  let text: string;
  if (!pick.meetsTarget) {
    text = `Belum ada varian yang mencapai win rate ≥${pct(TARGET_WR)} dengan ekspektasi positif di data pengembangan. Ekspektasi terbaik: ${label} — ${dev}.`;
  } else if (pick.verdict === "terbukti") {
    tone = "buy";
    text = `${label} dipilih dari data pengembangan (${dev}) dan TERBUKTI di data uji: ${test}.`;
  } else if (pick.verdict === "positif") {
    text = `${label} dipilih dari data pengembangan (${dev}). Di data uji: ${test} — masih positif, tetapi belum memenuhi target win rate atau belum signifikan secara statistik.`;
  } else if (pick.verdict === "gagal") {
    tone = "sell";
    text = `${label} dipilih dari data pengembangan (${dev}), tetapi GAGAL di data uji: ${test}. Kemungkinan hasil pengembangan kebetulan (overfitting) — jangan dipakai.`;
  } else {
    text = `${label} dipilih dari data pengembangan (${dev}); sampel data uji belum cukup untuk membuktikan (${test}).`;
  }
  return (
    <div className={cx("rounded-2xl border p-4 text-sm", tone === "buy" ? "border-buy/40 bg-buy/5 text-buy" : tone === "sell" ? "border-sell/40 bg-sell/5 text-sell" : "border-warn/40 bg-warn/5 text-warn")}>
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] opacity-80">Target win rate ≥{pct(TARGET_WR)} (tanpa mengurangi jumlah sinyal)</div>
      {text}
    </div>
  );
}

export function BacktestPanel() {
  const [row, setRow] = useState<ReportRow | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  const [set, setSet] = useState<"test" | "dev">("test");

  useEffect(() => {
    let alive = true;
    const load = () =>
      supabase()
        .from("strategy_report")
        .select("version,computed_at,source,chunks,report")
        .eq("id", "current")
        .maybeSingle()
        .then(({ data, error }) => {
          if (!alive) return;
          if (error) setErr(error.message);
          setRow((data as ReportRow | null) ?? null);
        });
    void load();
    const t = setInterval(load, 120000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (row === undefined) return <p className="text-sm text-muted">Memuat hasil backtest…</p>;
  if (!row) return <Empty title="Backtest belum tersedia">Engine sedang mengisi data riwayat bertahap (satu minggu data tiap 10 menit). Halaman ini terisi otomatis.</Empty>;

  const r = row.report;
  const groups = set === "test" ? r.test : r.dev;
  const all = groups.find((g) => g.key === "all");
  const rec = recommendation(r.test.find((g) => g.key === "all"), r.minSamples);
  const best = all ? MGMT_VARIANTS.reduce((b, v) => ((all.variants[v].expPips ?? -Infinity) > (all.variants[b].expPips ?? -Infinity) ? v : b), "A" as MgmtVariant) : "A";
  const d = (s: number) => new Date(s * 1000).toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
  const order = (k: string) => (k === "all" ? 0 : k.startsWith("strategy") ? 1 : k.startsWith("session") ? 2 : 3);

  return (
    <div className="space-y-4">
      {err && <p className="text-xs text-sell">Gagal memuat: {err}</p>}
      <div className="rounded-xl border border-info/40 bg-info/5 p-3 text-xs text-info">
        <b>Simulasi historis, bukan hasil trading Anda.</b> Sumber {row.source}. Periode {d(r.periodFrom)} – {d(r.periodTo)} ({fmt(r.weeks, 1)} minggu, {row.chunks} potongan
        {row.chunks < TARGET_CHUNKS ? ` dari target ±${TARGET_CHUNKS} — pengisian masih berjalan` : ""}). Biaya: spread {r.options.spreadPips} + slippage {r.options.slippagePips} pips per trade; batas tahan {Math.round(r.options.maxHoldSec / 3600)} jam; SL & TP dalam satu candle dihitung SL. Pemisahan kronologis: {Math.round(r.options.devRatio * 100)}% awal = pengembangan, sisanya = uji (headline).
      </div>

      <div className={cx("rounded-2xl border p-4 text-sm", rec.tone === "buy" ? "border-buy/40 bg-buy/5 text-buy" : rec.tone === "sell" ? "border-sell/40 bg-sell/5 text-sell" : "border-warn/40 bg-warn/5 text-warn")}>
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] opacity-80">Kesimpulan data uji</div>
        {rec.text}
      </div>

      <TargetWinRate report={r} />

      <div className="flex flex-wrap items-center gap-2">
        <h2 className="card-title mr-auto">Perbandingan manajemen posisi · {set === "test" ? "data uji (out-of-sample)" : "data pengembangan"}</h2>
        {(["test", "dev"] as const).map((k) => (
          <button key={k} className={cx("chip", set === k ? "border-gold/60 bg-gold/10 text-gold" : "border-line text-muted")} onClick={() => setSet(k)}>
            {k === "test" ? "Data uji" : "Data pengembangan"}
          </button>
        ))}
      </div>
      {all ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {MGMT_VARIANTS.map((v) => (
            <VariantCard key={v} v={v} s={all.variants[v]} best={v === best && (all.variants[v].expPips ?? 0) > 0} />
          ))}
        </div>
      ) : (
        <Empty title="Belum ada trade pada bagian ini" />
      )}

      <Card title="Rincian per strategi, sesi, dan arah">
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Grup</th>
                <th>Setup</th>
                <th>Entry tersentuh</th>
                <th>TP1 sebelum SL</th>
                <th>TP2</th>
                {MGMT_VARIANTS.map((v) => (
                  <th key={v}>E[{v}]</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...groups]
                .sort((a, b) => order(a.key) - order(b.key) || a.key.localeCompare(b.key))
                .map((g) => {
                  const small = g.variants.A.n < r.minSamples;
                  return (
                    <tr key={g.key} className={cx(g.key === "all" && "font-semibold")}>
                      <td>
                        {groupLabel(g.key)}
                        {small && <span className="ml-1 text-[10px] text-warn">(n kecil)</span>}
                      </td>
                      <td className="num">{g.setups}</td>
                      <td className="num">{pct(g.probabilities.entry.p)}</td>
                      <td className="num">{pct(g.probabilities.tp1.p)}</td>
                      <td className="num">{pct(g.probabilities.tp2.p)}</td>
                      {MGMT_VARIANTS.map((v) => (
                        <td key={v} className={cx("num", (g.variants[v].expPips ?? 0) > 0 ? "text-buy" : (g.variants[v].expPips ?? 0) < 0 ? "text-sell" : "text-muted")}>
                          {signed(g.variants[v].expPips)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
        <ul className="mt-3 space-y-1 text-xs text-muted">
          <li>• E[A–F] = ekspektasi pips per trade (biaya termasuk) untuk setup yang entry-nya tersentuh dan hasilnya tuntas.</li>
          <li>• A = seluruh posisi di TP1/SL · B = 1/3 di TP1, TP2, TP3 dengan SL tetap · C = seperti B, SL sisa posisi pindah ke entry (BE) setelah TP1.</li>
          <li>• D/E = seluruh posisi di TP cepat 0,4R / 0,6R (M15 ±20 / ±30 pips, H1 ±40 / ±60 pips) · F = 1/2 di 0,6R lalu SL ke BE, sisa ke TP2. TP dekat menaikkan win rate tetapi memperkecil kemenangan — yang menentukan tetap ekspektasi.</li>
          <li>• Rencana level: M15 SL 50 / TP 50-100-150 pips; H1 SL 100 / TP 100-200-300 pips.</li>
          <li>• Data PAXG/USDT adalah proxy emas (pergerakan relatif mirip XAUUSD, tetapi tidak identik). Grup dengan n &lt; {r.minSamples} belum layak dijadikan pegangan.</li>
        </ul>
      </Card>
    </div>
  );
}
