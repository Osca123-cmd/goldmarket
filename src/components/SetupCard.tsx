"use client";

import Link from "next/link";
import { useState } from "react";
import { floatingPips, isActiveSignal, isRunningSignal, type SetupRow } from "@/lib/market";
import { OPPORTUNITY_STATUS_LABEL } from "@/core/setups";
import { STRATEGY_LABEL } from "@/core/config";
import { ago, cx, fmt, fmtTime } from "./ui";
import { SignalBar } from "./LevelBar";
import { ProbabilityBox } from "./ProbabilityBox";

const STATUS_TEXT: Record<SetupRow["status"], string> = {
  approaching: "text-info",
  awaiting_confirmation: "text-gold",
  entry_touched: "text-buy",
  invalid: "text-sell",
  expired: "text-muted",
};

const ORDER: Record<SetupRow["entry_type"], string> = { market: "Order market", limit: "Order limit", stop: "Order stop" };

/** Tiket sinyal: arah, timeframe & strategi, lalu bar progres SL → Entry → TP3 dengan posisi harga sekarang. */
export function SetupCard({ s, price, tz, now, pipSize = 0.1, bare }: { s: SetupRow; price: number | null; tz: string; now: number; minScore?: number; pipSize?: number; /** tanpa bingkai, untuk ditaruh langsung di panel */ bare?: boolean }) {
  const [open, setOpen] = useState(false);
  const pip = s.pip_size || pipSize;
  const active = isActiveSignal(s);
  const running = isRunningSignal(s);
  const float = running && price != null ? floatingPips(s.direction, s.entry_price, price, pip) : null;
  const tpHit = s.outcome_tp ?? 0;
  const link = "rounded text-sm font-medium text-gold underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold";
  return (
    <article className={cx("fade-in", bare ? "px-4 py-5 sm:px-6" : "rounded-2xl border border-line bg-surface-2/30 p-4 sm:p-5", !active && !running && "opacity-75")}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={cx("text-xl font-bold", s.direction === "BUY" ? "text-buy" : "text-sell")}>{s.direction}</span>
        <span className="text-xl font-semibold text-ink">{s.timeframe}</span>
        <span className="text-sm text-muted">{STRATEGY_LABEL[s.strategy]}</span>
        <span className={cx("ml-auto text-sm font-medium", running ? (tpHit ? "text-buy" : "text-info") : STATUS_TEXT[s.status])}>
          {running ? (tpHit ? `TP${tpHit} tersentuh` : "Berjalan") : s.status === "approaching" ? "Menunggu entry" : OPPORTUNITY_STATUS_LABEL[s.status]}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted">
        {ORDER[s.entry_type]}, konfirmasi di {s.confirm_tf}. Skor kualitas {s.score} dari 100{s.confirmed_at ? ", sudah terkonfirmasi" : ""}.
      </p>
      {!s.eligible && <p className="mt-1 text-xs text-warn">Belum layak dikirim sebagai sinyal: {s.status_reason ?? "syarat wajib belum terpenuhi"}</p>}

      {running && (
        <p className="mt-3 text-sm text-ink">
          Floating{" "}
          <span className={cx("num font-bold", float == null ? "text-muted" : float >= 0 ? "text-buy" : "text-sell")}>{float == null ? "—" : `${float > 0 ? "+" : ""}${fmt(float, 1)} pips`}</span>
        </p>
      )}
      {running && tpHit > 0 && (
        <p className="mt-2 rounded-xl border border-gold/40 bg-gold/10 px-3 py-2 text-sm text-ink">
          <strong className="text-gold">TP{tpHit} tersentuh — geser SL ke entry <span className="num">{fmt(s.entry_price)}</span> (BE).</strong> Bila harga kembali ke entry, sinyal ditutup menang +{fmt(Math.abs([s.tp1, s.tp2, s.tp3][tpHit - 1] - s.entry_price) / pip, 0)} pips.
        </p>
      )}

      <div className="mt-2">
        <SignalBar s={s} price={price} entered={running} priceText={float != null ? `${float > 0 ? "+" : ""}${fmt(float, 0)} pips` : undefined} />
      </div>

      <p className="mt-3 text-xs text-muted">
        {s.eligible && s.status_reason ? `${s.status_reason} ` : ""}
        {active ? `Berlaku sampai ${fmtTime(s.expires_at, tz, true)}, dibuat ${ago(s.created_at, now)}.` : ""}
      </p>

      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
        <button className={link} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? "Tutup alasan" : "Alasan & skor"}
        </button>
        <Link className={link} href={`/chart/?setup=${s.id}&tf=${s.timeframe}`}>
          Buka di chart
        </Link>
        <Link className={link} href={`/journal/?fromSetup=${s.id}`} title="Membuka formulir jurnal berisi level setup. Tidak membuka posisi di broker.">
          Catat ke jurnal
        </Link>
      </div>

      {open && (
        <div className="mt-4 grid gap-4 border-t border-line pt-4 lg:grid-cols-2">
          <div>
            <h4 className="mb-1 text-sm font-semibold text-ink">Alasan analisis</h4>
            <ul className="list-disc space-y-1 pl-4 text-xs text-ink/90">
              {s.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
            <h4 className="mb-1 mt-3 text-sm font-semibold text-ink">Syarat wajib</h4>
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
            <h4 className="mb-1 text-sm font-semibold text-ink">Skor kualitas (berbasis aturan)</h4>
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
