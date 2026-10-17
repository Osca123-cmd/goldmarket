"use client";

import type { ReactNode } from "react";
import { cx, fmt } from "./ui";

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
