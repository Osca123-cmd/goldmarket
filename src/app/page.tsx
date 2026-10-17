"use client";

import Link from "next/link";
import { AppShell } from "@/components/Shell";
import { useMarket } from "@/components/MarketContext";
import { SessionsCard } from "@/components/SessionsCard";
import { SetupCard } from "@/components/SetupCard";
import { Card, Disclaimer, Empty, Stat, StatusBadge, ago, cx, fmt, fmtTime, useNow } from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { effectiveStatus, isActiveSignal, useEconEvents } from "@/lib/market";
import { NextEvent } from "@/components/NextEvent";
import { ANALYSIS_STATUS_LABEL } from "@/core/analysis";

export default function DashboardPage() {
  return (
    <AppShell>
      <Dashboard />
    </AppShell>
  );
}

const BIAS_TONE: Record<string, string> = { bullish: "text-buy", bearish: "text-sell", ranging: "text-muted" };

function Dashboard() {
  const { snapshot, analysis, setups, channel } = useMarket();
  const { settings } = useAuth();
  const tz = settings?.display_tz ?? "Asia/Jakarta";
  const now = useNow(1000);
  const status = effectiveStatus(snapshot, now);
  const up = (snapshot?.day_change ?? 0) >= 0;
  const active = setups.filter((s) => s.eligible && isActiveSignal(s) && s.score >= (settings?.min_score?.[s.timeframe] ?? 60));
  const { data: events } = useEconEvents();
  const nextEvent = (events ?? []).find((e) => e.impact === "High" && Date.parse(e.time_at) > now) ?? null;

  return (
    <div className="space-y-4">
      {nextEvent && Date.parse(nextEvent.time_at) - now <= 24 * 3600 * 1000 && (
        <Link href="/news/" className="block">
          <NextEvent ev={nextEvent} now={now} tz={tz} />
        </Link>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="XAUUSD" action={<StatusBadge status={status} />}>
          <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
            <div className="num text-4xl font-bold tracking-tight sm:text-5xl">{fmt(snapshot?.price)}</div>
            {snapshot?.day_change != null && (
              <div className={cx("num pb-1 text-lg font-semibold", up ? "text-buy" : "text-sell")}>
                {up ? "▲ +" : "▼ "}
                {fmt(snapshot.day_change)} ({up ? "+" : ""}
                {fmt(snapshot.day_change_pct)}%)
              </div>
            )}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Stat label="Bid" value={snapshot?.supports_bid_ask ? fmt(snapshot?.bid) : "Tidak tersedia"} />
            <Stat label="Ask" value={snapshot?.supports_bid_ask ? fmt(snapshot?.ask) : "Tidak tersedia"} />
            <Stat label="Spread" value={snapshot?.spread_pips != null ? `${fmt(snapshot.spread_pips, 1)} pips` : "Tidak tersedia"} sub={snapshot?.proxy_note && !snapshot.is_demo ? "spread instrumen proxy" : undefined} />
            <Stat label="High harian" value={fmt(snapshot?.day_high)} />
            <Stat label="Low harian" value={fmt(snapshot?.day_low)} />
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            <span>
              Harga: <span className="text-ink">{fmtTime(snapshot?.quote_time, tz)}</span> ({ago(snapshot?.quote_time, now)})
            </span>
            <span>
              Sumber: <span className="text-ink">{snapshot?.source_label ?? "—"}</span>
            </span>
            <span>
              Pasar: <span className="text-ink">{snapshot?.market_open == null ? "—" : snapshot.market_open ? "Buka" : "Tutup"}</span>
            </span>
            <span>
              Koneksi browser: <span className="text-ink">{channel === "websocket" ? "WebSocket realtime" : channel === "polling" ? "Polling (fallback)" : channel}</span>
            </span>
          </div>
          {snapshot?.proxy_note && <p className={cx("mt-3 rounded-lg border p-2 text-xs", snapshot.is_demo ? "border-info/40 text-info" : "border-warn/40 text-warn")}>{snapshot.proxy_note}</p>}
          {snapshot?.last_error && <p className="mt-2 text-xs text-sell">Gangguan feed: {snapshot.last_error}</p>}
        </Card>

        <Card title="Status analisis" action={analysis && <span className="text-[11px] text-muted">{ago(analysis.created_at, now)}</span>}>
          {!analysis ? (
            <Empty title="Menunggu analisis pertama">Engine berjalan otomatis tiap menit di server.</Empty>
          ) : (
            <>
              <div className={cx("text-2xl font-bold", analysis.status === "no_valid_setup" ? "text-muted" : analysis.status === "awaiting_confirmation" ? "text-gold" : BIAS_TONE[analysis.status])}>
                {ANALYSIS_STATUS_LABEL[analysis.status]}
              </div>
              <div className="mt-1 text-sm text-muted">
                Bias utama (H4+H1): <span className={cx("font-semibold", BIAS_TONE[analysis.main_bias])}>{analysis.main_bias}</span>
                {analysis.strong_bias && " · kuat"}
              </div>
              {!analysis.quality_ok && (
                <ul className="mt-3 space-y-1 rounded-lg border border-warn/40 bg-warn/5 p-2 text-xs text-warn">
                  <li className="font-semibold">Sinyal baru dihentikan:</li>
                  {analysis.quality_reasons.map((r, i) => (
                    <li key={i}>• {r}</li>
                  ))}
                </ul>
              )}
              <ul className="mt-3 space-y-1 text-xs text-ink/85">
                {analysis.reasons.map((r, i) => (
                  <li key={i}>• {r}</li>
                ))}
              </ul>
            </>
          )}
        </Card>
      </div>

      {analysis && Object.keys(analysis.timeframes).length > 0 && (
        <Card title="Ringkasan multi-timeframe">
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>TF</th>
                  <th>Peran</th>
                  <th>Bias</th>
                  <th>Struktur</th>
                  <th>EMA20 / 50 / 200</th>
                  <th>RSI 14</th>
                  <th>ATR 14</th>
                </tr>
              </thead>
              <tbody>
                {(["H4", "H1", "M15", "M5"] as const).map((tf) => {
                  const a = analysis.timeframes[tf];
                  if (!a) return null;
                  return (
                    <tr key={tf}>
                      <td className="font-semibold">{tf}</td>
                      <td className="text-muted">{tf === "H4" || tf === "H1" ? "Bias tren" : tf === "M15" ? "Konteks setup" : "Konfirmasi entry"}</td>
                      <td className={BIAS_TONE[a.bias]}>{a.bias}</td>
                      <td className="text-muted">{a.structure}</td>
                      <td className="num">
                        {fmt(a.ema20)} / {fmt(a.ema50)} / {fmt(a.ema200)}
                      </td>
                      <td className="num">{fmt(a.rsi, 1)}</td>
                      <td className="num">{fmt(a.atr)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <div className="grid gap-4 xl:grid-cols-5">
        <div className="min-w-0 space-y-3 xl:col-span-3">
          <div className="flex items-center justify-between">
            <h2 className="card-title">Peluang aktif teratas</h2>
            <Link href="/opportunities/" className="text-xs text-gold hover:underline">
              Semua peluang →
            </Link>
          </div>
          {active.length === 0 ? (
            <Empty title="Belum ada setup valid">Engine tidak memaksakan sinyal. Setup muncul hanya jika syarat data, struktur, invalidasi, dan risiko terpenuhi.</Empty>
          ) : (
            active.slice(0, 3).map((s) => <SetupCard key={s.id} s={s} price={snapshot?.price ?? null} tz={tz} now={now} minScore={settings?.min_score?.[s.timeframe]} pipSize={settings?.pip_size} />)
          )}
        </div>
        <div className="min-w-0 xl:col-span-2">
          <SessionsCard source={snapshot?.source ?? null} defaultTz={tz} />
        </div>
      </div>
      <Disclaimer />
    </div>
  );
}
