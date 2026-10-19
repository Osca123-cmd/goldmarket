"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { cx, fmt } from "./ui";
import { STRATEGY_LABEL } from "@/core/config";
import type { SetupRow } from "@/lib/market";

export type ResultKind = "win" | "loss" | "be" | "open" | "timeout" | "cancelled";

const RESULT: Record<ResultKind, { label: string; cls: string }> = {
  win: { label: "WIN", cls: "bg-buy/15 text-buy" },
  loss: { label: "LOSS", cls: "bg-sell/15 text-sell" },
  be: { label: "BE", cls: "bg-muted/15 text-muted" },
  open: { label: "OPEN", cls: "bg-info/15 text-info" },
  timeout: { label: "TIMEOUT", cls: "bg-warn/15 text-warn" },
  cancelled: { label: "BATAL", cls: "bg-muted/10 text-muted" },
};

const GRADE: Record<string, string> = {
  "A+": "bg-gold/15 text-gold",
  A: "bg-info/15 text-info",
  B: "bg-surface-2 text-muted",
  C: "bg-surface-2 text-muted",
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
}) {
  const r = RESULT[result];
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      onClick={onClick}
      className={cx(
        "flex w-full items-center gap-3 border-b border-line/70 px-3 py-3 text-left transition sm:gap-4 sm:px-5 sm:py-4",
        onClick && "hover:bg-surface-2/60",
        active && "bg-gold/5",
      )}
    >
      <span
        className={cx(
          "grid h-12 w-12 shrink-0 place-items-center rounded-xl border text-xs font-extrabold sm:h-14 sm:w-14 sm:text-sm",
          direction === "BUY" ? "border-buy/40 bg-buy/10 text-buy" : "border-sell/40 bg-sell/10 text-sell",
        )}
      >
        {direction}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="num text-base font-bold tracking-wide">XAUUSD</span>
          <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold text-muted">{timeframe}</span>
          {grade && <span className={cx("rounded-md px-1.5 py-0.5 text-[10px] font-bold", GRADE[grade] ?? GRADE.B)}>{grade}</span>}
        </span>
        <span className="num mt-0.5 block truncate text-xs text-muted">{time}</span>
        {sub && <span className="mt-0.5 block truncate text-[11px] text-muted/80">{sub}</span>}
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1">
        <span className={cx("rounded-full px-2.5 py-0.5 text-[11px] font-extrabold tracking-wide", r.cls)}>{r.label}</span>
        <span className={cx("num text-sm font-bold", pips == null ? "text-muted" : pips > 0 ? "text-buy" : pips < 0 ? "text-sell" : "text-muted")}>
          {pips == null ? "—" : `${pips > 0 ? "+" : ""}${fmt(pips, 1)}`}
        </span>
      </span>
    </Tag>
  );
}

export function HistoryPanel({ title, action, children, summary }: { title: string; action?: ReactNode; children: ReactNode; summary?: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-surface fade-in">
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3 sm:px-5">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted" aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
        <h2 className="mr-auto text-xs font-bold uppercase tracking-[0.2em] text-ink/80">{title}</h2>
        {action}
      </header>
      {summary && <div className="border-b border-line px-4 py-3 sm:px-5">{summary}</div>}
      <div>{children}</div>
    </section>
  );
}

const ENTRY_TYPE: Record<SetupRow["entry_type"], string> = { market: "Market", limit: "Limit", stop: "Stop" };

/** Detail level sinyal (entry, SL, TP) — dibuka dengan mengetuk baris riwayat. */
export function SignalDetails({ s, tz, extra }: { s: SetupRow; tz: string; extra?: ReactNode }) {
  const t = (iso: string | null) => (iso ? new Date(iso).toLocaleString("id-ID", { timeZone: tz, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
  const cell = (label: string, value: string, tone = "text-ink", note?: string) => (
    <div className="rounded-xl bg-surface-2/60 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className={cx("num text-sm font-bold", tone)}>{value}</div>
      {note && <div className="text-[10px] text-muted">{note}</div>}
    </div>
  );
  const pip = s.pip_size || 0.1;
  const dist = (p: number) => `${fmt(Math.abs(p - s.entry_price) / pip, 0)} pips`;
  return (
    <div className="space-y-2 border-b border-line/70 bg-surface-2/20 px-3 py-3 sm:px-5">
      <div className="text-xs text-muted">
        {STRATEGY_LABEL[s.strategy]} · {s.timeframe} (konfirmasi {s.confirm_tf}) · skor {s.score}/100
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {cell(`Entry (${ENTRY_TYPE[s.entry_type]})`, fmt(s.entry_price), "text-ink", `Zona ${fmt(s.entry_low)}–${fmt(s.entry_high)}`)}
        {cell("SL", fmt(s.sl), "text-sell", dist(s.sl))}
        {cell("TP1", fmt(s.tp1), "text-buy", dist(s.tp1))}
        {cell("TP2", fmt(s.tp2), "text-buy", dist(s.tp2))}
        {cell("TP3", fmt(s.tp3), "text-buy", dist(s.tp3))}
        {cell("Invalidasi", s.invalidation != null ? fmt(s.invalidation) : "—", "text-muted")}
        {cell("Dibuat", t(s.created_at), "text-ink")}
        {cell("Entry tersentuh", t(s.entry_touched_at), "text-ink")}
      </div>
      {s.outcome_note && <p className="text-xs text-muted">{s.outcome_note}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <Link className="btn-ghost inline-block px-3 py-1.5 text-xs" href={`/chart/?setup=${s.id}&tf=${s.timeframe}`}>
          Tampilkan di chart
        </Link>
        {extra}
      </div>
    </div>
  );
}

/** Baris riwayat sinyal yang bisa diketuk untuk melihat level SL/TP. */
export function SignalHistoryItem({ s, tz, time, grade, extra }: { s: SetupRow; tz: string; time: string; grade: string | null; extra?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <HistoryRow
        direction={s.direction}
        timeframe={s.timeframe}
        grade={grade}
        time={time}
        result={s.outcome === "open" || !s.outcome ? "open" : s.outcome}
        pips={s.outcome === "open" ? null : s.outcome_pips}
        sub={open ? "Ketuk untuk menutup detail" : "Ketuk untuk lihat entry, SL & TP"}
        onClick={() => setOpen((v) => !v)}
        active={open}
      />
      {open && <SignalDetails s={s} tz={tz} extra={extra} />}
    </>
  );
}
