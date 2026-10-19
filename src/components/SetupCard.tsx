"use client";

import Link from "next/link";
import { useState } from "react";
import { isActiveSignal, type SetupRow } from "@/lib/market";
import { OPPORTUNITY_STATUS_LABEL } from "@/core/setups";
import { STRATEGY_LABEL } from "@/core/config";
import { priceToPips } from "@/core/instrument";
import { DirBadge, ScoreBar, ago, cx, fmt, fmtTime } from "./ui";
import { ProbabilityBox } from "./ProbabilityBox";

const STATUS_TONE: Record<SetupRow["status"], string> = {
  approaching: "border-info/50 text-info",
  awaiting_confirmation: "border-gold/50 text-gold",
  entry_touched: "border-buy/50 text-buy",
  invalid: "border-sell/50 text-sell",
  expired: "border-muted/50 text-muted",
};

const ENTRY_TYPE_LABEL = { market: "Market", limit: "Limit", stop: "Stop" } as const;

export function SetupCard({ s, price, tz, now, minScore, pipSize = 0.1}: { s: SetupRow; price: number | null; tz: string; now: number; minScore?: number; pipSize?: number }) {
  const [open, setOpen] = useState(false);
  const dist = price != null ? priceToPips(Math.abs(price - s.entry_price), { symbol: "", pipSize, tickSize: 0.01, digits: 2, contractSize: 100, quoteCurrency: "USD" }) : s.distance_pips;
  const active = isActiveSignal(s);
  return (
    <article className={cx("rounded-2xl border bg-surface p-4 fade-in", s.direction === "BUY" ? "border-buy/25" : "border-sell/25", !active && "opacity-75")}>
      <div className="flex flex-wrap items-center gap-2">
        <DirBadge dir={s.direction} />
        <span className="text-sm font-semibold">{STRATEGY_LABEL[s.strategy]}</span>
        <span className="chip border-line text-muted">
          {s.timeframe} · konfirmasi {s.confirm_tf}
        </span>
        <span className={cx("chip", STATUS_TONE[s.status])}>{OPPORTUNITY_STATUS_LABEL[s.status]}</span>
        {!s.eligible && <span className="chip border-sell/50 text-sell">Tidak layak</span>}
        {s.confirmed_at && <span className="chip border-buy/40 text-buy">Terkonfirmasi</span>}
        <div className="ml-auto">
          <ScoreBar score={s.score} min={minScore} />
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4 lg:grid-cols-7">
        <Lv label={`Entry (${ENTRY_TYPE_LABEL[s.entry_type]})`} v={fmt(s.entry_price)} sub={`Area ${fmt(s.entry_low)}–${fmt(s.entry_high)}`} />
        <Lv label="Invalidasi" v={fmt(s.invalidation)} />
        <Lv label="SL" v={fmt(s.sl)} tone="sell" sub={`${s.sl_pips} pips`} />
        <Lv label="TP1" v={fmt(s.tp1)} tone="buy" sub={`RR ${fmt(s.rr?.tp1, 1)}`} />
        <Lv label="TP2" v={fmt(s.tp2)} tone="buy" sub={`RR ${fmt(s.rr?.tp2, 1)}`} />
        <Lv label="TP3" v={fmt(s.tp3)} tone="buy" sub={`RR ${fmt(s.rr?.tp3, 1)}`} />
        <Lv label="Jarak ke entry" v={dist != null ? `${fmt(dist, 1)} pips` : "—"} sub={`Usia ${ago(s.created_at, now)}`} />
      </div>

      <p className="mt-3 text-xs text-muted">
        {s.status_reason ?? ""} {active && <>Kedaluwarsa {fmtTime(s.expires_at, tz, true)}.</>}
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? "Sembunyikan detail" : "Lihat alasan & skor"}
        </button>
        <Link className="btn-ghost px-3 py-1.5 text-xs" href={`/chart/?setup=${s.id}&tf=${s.timeframe}`}>
          Tampilkan di chart
        </Link>
        <Link className="btn-ghost px-3 py-1.5 text-xs" href={`/journal/?fromSetup=${s.id}`} title="Membuka formulir jurnal berisi level setup. Tidak membuka posisi di broker.">
          Catat ke jurnal (manual)
        </Link>
      </div>

      {open && (
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <div>
            <h4 className="card-title mb-1">Alasan analisis</h4>
            <ul className="list-disc space-y-1 pl-4 text-xs text-ink/90">
              {s.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
            <h4 className="card-title mb-1 mt-3">Syarat wajib</h4>
            <ul className="space-y-1 text-xs">
              {s.gates.map((g) => (
                <li key={g.key} className="flex gap-2">
                  <span className={g.pass ? "text-buy" : "text-sell"}>{g.pass ? "✓" : "✗"}</span>
                  <span>
                    <strong>{g.label}:</strong> <span className="text-muted">{g.note}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h4 className="card-title mb-1">Skor kualitas (berbasis aturan)</h4>
            <ul className="space-y-1 text-xs">
              {s.score_breakdown.components.map((c) => (
                <li key={c.key} className="flex justify-between gap-2">
                  <span>
                    {c.label} <span className="text-muted">— {c.note}</span>
                  </span>
                  <span className="num shrink-0">
                    {c.points}/{c.max}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11px] text-muted">Skor bukan peluang menang. Skor 80/100 tidak berarti 80% menang.</p>
            <div className="mt-3">
              <ProbabilityBox strategy={s.strategy} timeframe={s.timeframe} />
            </div>
            <p className="mt-2 text-[11px] text-muted">
              Sumber data: {s.data_source} · waktu data {fmtTime(s.data_time, tz, true)} · ID {s.id.slice(0, 8)}
            </p>
          </div>
        </div>
      )}
    </article>
  );
}

function Lv({ label, v, sub, tone }: { label: string; v: string; sub?: string; tone?: "buy" | "sell" }) {
  return (
    <div className="min-w-0 rounded-lg bg-surface-2/60 px-2.5 py-2">
      <div className="truncate text-[10px] uppercase tracking-wide text-muted">{label}</div>
      <div className={cx("num truncate font-semibold", tone === "buy" && "text-buy", tone === "sell" && "text-sell")}>{v}</div>
      {sub && <div className="truncate text-[10px] text-muted">{sub}</div>}
    </div>
  );
}
