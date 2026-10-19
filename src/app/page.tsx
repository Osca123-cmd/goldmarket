"use client";

import Link from "next/link";
import { AppShell } from "@/components/Shell";
import { useMarket } from "@/components/MarketContext";
import { SessionsCard } from "@/components/SessionsCard";
import { SetupCard } from "@/components/SetupCard";
import { findConflicts } from "@/core/conflict";
import { useEffect, useState } from "react";
import { Card, Disclaimer, Empty, StatusBadge, ago, cx, fmt, fmtTime, useNow } from "@/components/ui";
import { LogoMark } from "@/components/Logo";
import { useAuth } from "@/lib/auth";
import { effectiveStatus, fetchCandles, isActiveSignal, isRunningSignal, useEconEvents } from "@/lib/market";
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
const BIAS_PILL: Record<string, string> = { bullish: "border-buy/40 bg-buy/10 text-buy", bearish: "border-sell/40 bg-sell/10 text-sell", ranging: "border-blue-strong/30 bg-blue/10 text-blue-strong" };
const BIAS_SHORT: Record<string, string> = { bullish: "Bull", bearish: "Bear", ranging: "Range" };

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-blue/20 bg-[#0a1435]/70 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">{label}</div>
      <div className="num mt-0.5 truncate text-sm font-semibold sm:text-base">{value}</div>
      {hint && <div className="truncate text-[10px] text-muted">{hint}</div>}
    </div>
  );
}

/** Posisi harga di antara low & high harian. */
function DayRange({ low, high, price }: { low: number | null; high: number | null; price: number | null }) {
  if (low == null || high == null || price == null || high <= low) return null;
  const pct = Math.min(100, Math.max(0, ((price - low) / (high - low)) * 100));
  return (
    <div className="mt-4">
      <div className="mb-1 flex justify-between text-[11px] text-muted">
        <span>
          Low <span className="num text-sell">{fmt(low)}</span>
        </span>
        <span>Rentang harian</span>
        <span>
          High <span className="num text-buy">{fmt(high)}</span>
        </span>
      </div>
      <div className="relative h-2 rounded-full bg-gradient-to-r from-sell/50 via-blue/50 to-buy/50">
        <span className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-bg bg-gold shadow-[0_0_12px_rgba(232,184,76,0.8)]" style={{ left: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Grafik mini 24 jam (candle M15 tertutup dari server). */
function Sparkline({ source, up }: { source: string | null; up: boolean }) {
  const [pts, setPts] = useState<number[]>([]);
  useEffect(() => {
    if (!source) return;
    let alive = true;
    const load = () =>
      fetchCandles(source, "M15", 96)
        .then((c) => alive && setPts(c.map((x) => x.close)))
        .catch(() => undefined);
    void load();
    const t = setInterval(load, 60000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [source]);
  if (pts.length < 2) return <div className="h-20 rounded-xl border border-dashed border-line/60" aria-hidden />;
  const w = 300;
  const h = 80;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const x = (i: number) => (i / (pts.length - 1)) * w;
  const y = (v: number) => h - 4 - ((v - min) / (max - min || 1)) * (h - 8);
  const line = pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  return (
    <div className="min-w-0">
      <svg viewBox={`0 0 ${w} ${h}`} className="h-20 w-full" preserveAspectRatio="none" role="img" aria-label="Grafik harga 24 jam terakhir (M15)">
        <defs>
          <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#2f6bff" stopOpacity=".45" />
            <stop offset="1" stopColor="#2f6bff" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={`${line} L${w} ${h} L0 ${h} Z`} fill="url(#spark-fill)" />
        <path d={line} fill="none" stroke={up ? "#ffd36a" : "#e8b84c"} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        <circle cx={x(pts.length - 1)} cy={y(pts[pts.length - 1])} r="3.5" fill="#ffd36a" />
      </svg>
      <div className="text-right text-[10px] text-muted">24 jam terakhir · M15</div>
    </div>
  );
}

/** RSI 0–100 dengan zona 30/70. */
function RsiMeter({ rsi }: { rsi: number | null }) {
  const v = rsi != null && Number.isFinite(rsi) ? Math.min(100, Math.max(0, rsi)) : null;
  return (
    <div className="mt-3">
      <div className="flex justify-between text-[11px]">
        <span className="text-muted">RSI 14</span>
        <span className={cx("num font-semibold", v == null ? "text-muted" : v >= 70 ? "text-sell" : v <= 30 ? "text-buy" : "text-ink")}>{v == null ? "—" : fmt(v, 1)}</span>
      </div>
      <div className="relative mt-1 h-1.5 rounded-full bg-surface-2">
        <span className="absolute inset-y-0 left-[30%] right-[30%] bg-blue/25" />
        {v != null && <span className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-blue to-gold" style={{ width: `${v}%` }} />}
      </div>
    </div>
  );
}

function Dashboard() {
  const { snapshot, analysis, setups, channel } = useMarket();
  const { settings } = useAuth();
  const tz = settings?.display_tz ?? "Asia/Jakarta";
  const now = useNow(1000);
  const status = effectiveStatus(snapshot, now);
  const up = (snapshot?.day_change ?? 0) >= 0;
  // sinyal berjalan selalu tampil walau skornya di bawah minimum (notifikasinya sudah terkirim)
  const active = setups.filter((s) => s.eligible && isActiveSignal(s) && (isRunningSignal(s) || s.score >= (settings?.min_score?.[s.timeframe] ?? 60)));
  const { data: events } = useEconEvents();
  const nextEvent = (events ?? []).find((e) => e.topic && Date.parse(e.time_at) > now) ?? null;

  return (
    <div className="space-y-4">
      {nextEvent && Date.parse(nextEvent.time_at) - now <= 24 * 3600 * 1000 && (
        <Link href="/news/" className="block">
          <NextEvent ev={nextEvent} now={now} tz={tz} />
        </Link>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <section className="card-hero fade-in min-w-0 lg:col-span-2">
          <div className="flex flex-wrap items-center gap-2">
            <LogoMark size={28} />
            <div className="mr-auto leading-tight">
              <div className="text-sm font-bold tracking-wider">XAUUSD</div>
              <div className="text-[11px] text-muted">Gold Spot / U.S. Dollar</div>
            </div>
            <span className={cx("chip", snapshot?.market_open ? "border-buy/40 bg-buy/10 text-buy" : "border-muted/40 bg-muted/10 text-muted")}>{snapshot?.market_open == null ? "—" : snapshot.market_open ? "Pasar buka" : "Pasar tutup"}</span>
            <StatusBadge status={status} />
          </div>

          <div className="mt-4 grid items-end gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
            <div className="min-w-0">
              <div className="num text-gold-gradient text-5xl font-extrabold tracking-tight sm:text-6xl">{fmt(snapshot?.price)}</div>
              {snapshot?.day_change != null && (
                <span className={cx("num mt-2 inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm font-semibold", up ? "bg-buy/15 text-buy" : "bg-sell/15 text-sell")}>
                  {up ? "▲ +" : "▼ "}
                  {fmt(snapshot.day_change)} ({up ? "+" : ""}
                  {fmt(snapshot.day_change_pct)}%)
                </span>
              )}
            </div>
            <Sparkline source={snapshot?.source ?? null} up={up} />
          </div>

          <DayRange low={snapshot?.day_low ?? null} high={snapshot?.day_high ?? null} price={snapshot?.price ?? null} />

          <div className="mt-4 grid grid-cols-3 gap-2">
            <Kpi label="Bid" value={snapshot?.supports_bid_ask ? fmt(snapshot?.bid) : "—"} hint={snapshot?.supports_bid_ask ? undefined : "tidak tersedia"} />
            <Kpi label="Ask" value={snapshot?.supports_bid_ask ? fmt(snapshot?.ask) : "—"} hint={snapshot?.supports_bid_ask ? undefined : "tidak tersedia"} />
            <Kpi label="Spread" value={snapshot?.spread_pips != null ? `${fmt(snapshot.spread_pips, 1)} pips` : "—"} hint={snapshot?.spread_pips == null ? "tidak tersedia" : snapshot?.proxy_note && !snapshot.is_demo ? "instrumen proxy" : undefined} />
          </div>

          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            <span>
              Update <span className="text-ink">{fmtTime(snapshot?.quote_time, tz)}</span> ({ago(snapshot?.quote_time, now)}) · harga diperbarui ±1×/menit
            </span>
            <span>
              Sumber <span className="text-ink">{snapshot?.source_label ?? "—"}</span>
            </span>
            <span>
              Koneksi <span className="text-ink">{channel === "websocket" ? "WebSocket realtime" : channel === "polling" ? "Polling (fallback)" : channel}</span>
            </span>
          </div>
          {snapshot?.proxy_note && <p className={cx("mt-3 rounded-xl border p-2 text-xs", snapshot.is_demo ? "border-info/40 bg-info/5 text-info" : "border-warn/40 bg-warn/5 text-warn")}>{snapshot.proxy_note}</p>}
          {snapshot?.last_error && <p className="mt-2 text-xs text-sell">Gangguan feed: {snapshot.last_error}</p>}
        </section>

        <Card title="Status analisis" action={analysis && <span className="text-[11px] text-muted">{ago(analysis.created_at, now)}</span>}>
          {!analysis ? (
            <Empty title="Menunggu analisis pertama">Engine berjalan otomatis tiap menit di server.</Empty>
          ) : (
            <>
              <div className={cx("inline-flex rounded-xl border px-3 py-1.5 text-xl font-bold", analysis.status === "no_valid_setup" ? "border-line text-muted" : analysis.status === "awaiting_confirmation" ? "border-gold/50 bg-gold/10 text-gold" : BIAS_PILL[analysis.status])}>
                {ANALYSIS_STATUS_LABEL[analysis.status]}
              </div>
              <div className="mt-2 text-sm text-muted">
                Bias utama (H1+M30): <span className={cx("font-semibold", BIAS_TONE[analysis.main_bias])}>{analysis.main_bias}</span>
                {analysis.strong_bias && " · kuat"}
              </div>
              <div className="mt-3 grid grid-cols-3 gap-1.5">
                {(["H1", "M30", "M15"] as const).map((tf) => {
                  const b = analysis.timeframes[tf]?.bias ?? null;
                  return (
                    <div key={tf} className={cx("rounded-lg border px-2 py-1.5 text-center", b ? BIAS_PILL[b] : "border-line text-muted")}>
                      <div className="text-[10px] font-semibold tracking-wider opacity-80">{tf}</div>
                      <div className="text-xs font-bold">{b ? BIAS_SHORT[b] : "—"}</div>
                    </div>
                  );
                })}
              </div>
              {!analysis.quality_ok && (
                <ul className="mt-3 space-y-1 rounded-xl border border-warn/40 bg-warn/5 p-2 text-xs text-warn">
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
        <section className="min-w-0">
          <h2 className="card-title mb-2">Ringkasan multi-timeframe</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {(["H1", "M30", "M15"] as const).map((tf) => {
              const a = analysis.timeframes[tf];
              if (!a) return null;
              return (
                <div key={tf} className="card fade-in min-w-0 !p-4">
                  <div className="flex items-center gap-2">
                    <span className="text-lg font-extrabold tracking-wide">{tf}</span>
                    <span className="mr-auto text-[11px] text-muted">{tf === "H1" ? "Bias tren" : tf === "M30" ? "Bias & setup" : "Setup & konfirmasi"}</span>
                    <span className={cx("chip font-semibold", BIAS_PILL[a.bias])}>{a.bias}</span>
                  </div>
                  <p className="mt-1 truncate text-xs text-muted" title={a.structure}>
                    {a.structure}
                  </p>
                  <RsiMeter rsi={a.rsi} />
                  <dl className="mt-3 grid grid-cols-3 gap-1 text-[11px]">
                    <div>
                      <dt className="text-muted">EMA20</dt>
                      <dd className="num text-blue-strong">{fmt(a.ema20)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted">EMA50</dt>
                      <dd className="num text-gold">{fmt(a.ema50)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted">EMA200</dt>
                      <dd className="num">{fmt(a.ema200)}</dd>
                    </div>
                  </dl>
                  <div className="mt-2 text-[11px] text-muted">
                    ATR 14 <span className="num text-ink">{fmt(a.atr)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
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
            active.slice(0, 3).map((s) => <SetupCard key={s.id} s={s} price={snapshot?.price ?? null} tz={tz} now={now} minScore={settings?.min_score?.[s.timeframe]} pipSize={settings?.pip_size} conflicts={findConflicts(s, setups)} />)
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
