"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { cx, fmt } from "./ui";
import { PriceLadder, signalMarks } from "./PriceLadder";
import { STRATEGY_LABEL } from "@/core/config";
import { floatingPips, isRunningSignal, type SetupRow } from "@/lib/market";

export type ResultKind = "win" | "loss" | "be" | "open" | "timeout" | "cancelled" | "running" | "tp1" | "tp2" | "excluded";

const RESULT: Record<ResultKind, { label: string; text: string; dot: string }> = {
  win: { label: "Menang", text: "text-buy", dot: "bg-buy" },
  loss: { label: "Kalah", text: "text-sell", dot: "bg-sell" },
  be: { label: "Impas (BE)", text: "text-muted", dot: "bg-muted" },
  open: { label: "Terbuka", text: "text-info", dot: "bg-info" },
  timeout: { label: "Ditutup 24 jam", text: "text-warn", dot: "bg-warn" },
  cancelled: { label: "Batal", text: "text-muted", dot: "bg-line" },
  running: { label: "Berjalan", text: "text-info", dot: "bg-info" },
  tp1: { label: "TP1 tersentuh", text: "text-buy", dot: "bg-buy" },
  tp2: { label: "TP2 tersentuh", text: "text-buy", dot: "bg-buy" },
  excluded: { label: "Dikecualikan", text: "text-muted", dot: "bg-line" },
};

export function relTime(iso: string | null | undefined, now: number): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "baru saja";
  if (s < 3600) return `${Math.floor(s / 60)} menit lalu`;
  if (s < 86400) return `${Math.floor(s / 3600)} jam lalu`;
  return `${Math.floor(s / 86400)} hari lalu`;
}

export function HistoryRow({
  direction,
  timeframe,
  grade,
  time,
  result,
  pips,
  sub,
  onClick,
  active,
  pipsNote,
}: {
  direction: "BUY" | "SELL";
  timeframe: string;
  grade: string | null;
  time: string;
  result: ResultKind;
  pips: number | null;
  sub?: ReactNode;
  onClick?: () => void;
  active?: boolean;
  /** teks kecil di bawah angka pips (mis. "floating") */
  pipsNote?: string;
}) {
  const r = RESULT[result];
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      onClick={onClick}
      aria-expanded={onClick ? !!active : undefined}
      className={cx(
        "relative flex w-full items-start gap-3 py-3 pl-9 pr-4 text-left transition sm:pl-11 sm:pr-5",
        onClick && "hover:bg-surface-2/40 focus-visible:bg-surface-2/40 focus-visible:outline-none",
        active && "bg-surface-2/40",
      )}
    >
      {/* garis waktu */}
      <span className="absolute inset-y-0 left-4 w-px bg-line sm:left-5" aria-hidden />
      <span className={cx("absolute left-4 top-[1.1rem] h-2.5 w-2.5 -translate-x-1/2 rounded-full ring-4 ring-surface sm:left-5", r.dot)} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className={cx("text-sm font-bold", direction === "BUY" ? "text-buy" : "text-sell")}>{direction}</span>
          <span className="text-sm font-semibold text-ink">{timeframe}</span>
          {grade && <span className="text-xs text-muted">kualitas {grade}</span>}
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted">{time}</span>
        {sub && <span className="mt-0.5 block truncate text-xs text-muted/75">{sub}</span>}
      </span>
      <span className="shrink-0 text-right">
        <span className={cx("num block text-base font-bold", result === "excluded" ? "text-muted line-through" : pips == null ? "text-muted" : pips > 0 ? "text-buy" : pips < 0 ? "text-sell" : "text-muted")}>
          {pips == null ? "—" : `${pips > 0 ? "+" : ""}${fmt(pips, 1)}`}
        </span>
        <span className={cx("block text-xs font-medium", r.text)}>{r.label}</span>
        {pipsNote && <span className="block text-[11px] text-muted">{pipsNote}</span>}
      </span>
    </Tag>
  );
}

export function HistoryPanel({ title, action, children, summary }: { title: string; action?: ReactNode; children: ReactNode; summary?: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-surface fade-in">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pb-2 pt-4 sm:px-5">
        <h2 className="mr-auto text-base font-semibold text-ink">{title}</h2>
        {action}
      </header>
      {summary && <div className="px-4 pb-3 sm:px-5">{summary}</div>}
      <div className="border-t border-line">{children}</div>
    </section>
  );
}

/** Detail sinyal (peta level entry, SL, TP) — dibuka dengan mengetuk baris riwayat. */
export function SignalDetails({ s, tz, price, extra }: { s: SetupRow; tz: string; price: number | null; extra?: ReactNode }) {
  const t = (iso: string | null) => (iso ? new Date(iso).toLocaleString("id-ID", { timeZone: tz, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
  const pip = s.pip_size || 0.1;
  const running = isRunningSignal(s);
  const tpHit = s.outcome_tp ?? 0;
  const float = running && price != null ? floatingPips(s.direction, s.entry_price, price, pip) : null;
  const locked = tpHit > 0 ? Math.abs([s.tp1, s.tp2, s.tp3][tpHit - 1] - s.entry_price) / pip : null;
  return (
    <div className="space-y-3 border-y border-line/70 bg-surface-2/20 py-4 pl-9 pr-4 sm:pl-11 sm:pr-5">
      <p className="text-xs text-muted">
        {STRATEGY_LABEL[s.strategy]}, {s.timeframe} dengan konfirmasi {s.confirm_tf}, skor {s.score}/100. Dibuat {t(s.created_at)}, entry tersentuh {t(s.entry_touched_at)}.
      </p>
      <PriceLadder
        marks={signalMarks(s)}
        price={running ? price : null}
        anchor={running ? s.entry_price : undefined}
        direction={s.direction}
        priceNote={float != null ? `${float > 0 ? "+" : ""}${fmt(float, 1)} pips` : undefined}
        spread={120}
      />
      {running && locked != null && (
        <p className="text-xs text-ink/85">
          TP{tpHit} sudah tersentuh (+{fmt(locked, 1)} pips). SL ada di entry <span className="num">{fmt(s.entry_price)}</span>; bila harga kembali ke sana, sinyal ditutup menang +{fmt(locked, 1)} pips.
        </p>
      )}
      {s.outcome_note && <p className="text-xs text-muted">{s.outcome_note}</p>}
      {s.excluded && <p className="text-xs text-warn">Dikecualikan dari statistik: {s.excluded_reason ?? "atas permintaan pengguna"}</p>}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <Link className="text-sm font-medium text-gold underline-offset-4 hover:underline" href={`/chart/?setup=${s.id}&tf=${s.timeframe}`}>
          Buka di chart
        </Link>
        {extra}
      </div>
    </div>
  );
}

/** Baris riwayat sinyal yang bisa diketuk untuk melihat level SL/TP; sinyal berjalan menampilkan progres TP & floating. */
export function SignalHistoryItem({ s, tz, time, grade, price, extra }: { s: SetupRow; tz: string; time: string; grade: string | null; price: number | null; extra?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const running = isRunningSignal(s);
  const tpHit = s.outcome_tp ?? 0;
  const result: ResultKind = s.excluded ? "excluded" : running ? (tpHit >= 2 ? "tp2" : tpHit === 1 ? "tp1" : "running") : ((s.outcome ?? "open") as ResultKind);
  const pip = s.pip_size || 0.1;
  const float = running && price != null ? floatingPips(s.direction, s.entry_price, price, pip) : null;
  // setelah TP1 SL di BE: yang ditampilkan pips TP yang sudah aman, floating ada di detail
  const locked = running && tpHit > 0 ? Math.abs([s.tp1, s.tp2, s.tp3][tpHit - 1] - s.entry_price) / pip : null;
  return (
    <>
      <HistoryRow
        direction={s.direction}
        timeframe={s.timeframe}
        grade={grade}
        time={time}
        result={result}
        pips={locked ?? (running ? float : s.outcome_pips)}
        pipsNote={locked != null ? "aman, SL di BE" : running ? "floating" : undefined}
        sub={s.excluded ? `Tidak dihitung di statistik. ${s.excluded_reason ?? ""}` : undefined}
        onClick={() => setOpen((v) => !v)}
        active={open}
      />
      {open && <SignalDetails s={s} tz={tz} price={price} extra={extra} />}
    </>
  );
}
