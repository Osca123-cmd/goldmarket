"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { cx, fmt } from "./ui";
import { STRATEGY_LABEL } from "@/core/config";
import { floatingPips, isRunningSignal, type SetupRow } from "@/lib/market";

export type ResultKind = "win" | "loss" | "be" | "open" | "timeout" | "cancelled" | "running" | "tp1" | "tp2" | "excluded";

const RESULT: Record<ResultKind, { label: string; cls: string }> = {
  win: { label: "WIN", cls: "bg-buy/15 text-buy" },
  loss: { label: "LOSS", cls: "bg-sell/15 text-sell" },
  be: { label: "BE", cls: "bg-muted/15 text-muted" },
  open: { label: "OPEN", cls: "bg-info/15 text-info" },
  timeout: { label: "TIMEOUT", cls: "bg-warn/15 text-warn" },
  cancelled: { label: "BATAL", cls: "bg-muted/10 text-muted" },
  running: { label: "RUNNING", cls: "bg-info/15 text-info" },
  tp1: { label: "TP1 ✓", cls: "bg-buy/15 text-buy" },
  tp2: { label: "TP2 ✓", cls: "bg-buy/15 text-buy" },
  excluded: { label: "DIKECUALIKAN", cls: "bg-muted/15 text-muted" },
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
        <span className={cx("num text-sm font-bold", result === "excluded" ? "text-muted line-through" : pips == null ? "text-muted" : pips > 0 ? "text-buy" : pips < 0 ? "text-sell" : "text-muted")}>
          {pips == null ? "—" : `${pips > 0 ? "+" : ""}${fmt(pips, 1)}`}
        </span>
        {pipsNote && <span className="text-[10px] text-muted">{pipsNote}</span>}
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
export function SignalDetails({ s, tz, price, extra }: { s: SetupRow; tz: string; price: number | null; extra?: ReactNode }) {
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
  const running = isRunningSignal(s);
  const tpHit = s.outcome_tp ?? 0;
  const float = running && price != null ? floatingPips(s.direction, s.entry_price, price, pip) : null;
  const locked = tpHit > 0 ? Math.abs([s.tp1, s.tp2, s.tp3][tpHit - 1] - s.entry_price) / pip : null;
  return (
    <div className="space-y-2 border-b border-line/70 bg-surface-2/20 px-3 py-3 sm:px-5">
      {running && <ProgressLadder s={s} price={price} />}
      {running && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <span>
            Floating{" "}
            <span className={cx("num font-bold", float == null ? "text-muted" : float >= 0 ? "text-buy" : "text-sell")}>
              {float == null ? "—" : `${float > 0 ? "+" : ""}${fmt(float, 1)} pips`}
            </span>
          </span>
          {locked != null && (
            <span>
              TP{tpHit} sudah tersentuh <span className="num font-bold text-buy">+{fmt(locked, 1)} pips</span>
            </span>
          )}
          {locked != null && (
            <span className="text-muted">
              SL dipindah ke entry (BE) <span className="num font-semibold text-ink">{fmt(s.entry_price)}</span> — bila tersentuh, ditutup WIN +{fmt(locked, 1)} pips
            </span>
          )}
        </div>
      )}
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
      {s.excluded && <p className="text-xs text-warn">Dikecualikan dari statistik: {s.excluded_reason ?? "atas permintaan pengguna"}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <Link className="btn-ghost inline-block px-3 py-1.5 text-xs" href={`/chart/?setup=${s.id}&tf=${s.timeframe}`}>
          Tampilkan di chart
        </Link>
        {extra}
      </div>
    </div>
  );
}

/** Tangga level SL · Entry · TP1–TP3 dengan tanda TP yang sudah tersentuh dan posisi harga sekarang. */
function ProgressLadder({ s, price }: { s: SetupRow; price: number | null }) {
  const tpHit = s.outcome_tp ?? 0;
  const d = s.direction === "BUY" ? 1 : -1;
  const steps = [
    tpHit >= 1 ? { label: "SL → BE", value: s.entry_price, done: false, tone: "text-gold" } : { label: "SL", value: s.sl, done: false, tone: "text-sell" },
    { label: "Entry", value: s.entry_price, done: true, tone: "text-ink" },
    { label: "TP1", value: s.tp1, done: tpHit >= 1, tone: "text-buy" },
    { label: "TP2", value: s.tp2, done: tpHit >= 2, tone: "text-buy" },
    { label: "TP3", value: s.tp3, done: tpHit >= 3, tone: "text-buy" },
  ];
  // harga berada setelah level terakhir (Entry..TP3) yang sudah dilewati searah posisi; di sisi rugi → kotak SL
  const here = price == null ? -1 : steps.reduce((idx, st, i) => (i > 0 && d * (price - st.value) >= 0 ? i : idx), 0);
  return (
    <div className="grid grid-cols-5 gap-1 text-center">
      {steps.map((st, i) => (
        <div key={st.label} className={cx("rounded-lg border px-1 py-1.5", st.done && i > 1 ? "border-buy/50 bg-buy/10" : "border-line", i === here && "ring-1 ring-gold")}>
          <div className={cx("text-[10px] font-bold", st.tone)}>
            {st.label}
            {st.done && i > 1 ? " ✓" : ""}
          </div>
          <div className="num text-[11px]">{fmt(st.value)}</div>
          {i === here && <div className="text-[9px] font-semibold text-gold">{i === 0 ? "harga menuju sini" : "harga di sini"}</div>}
        </div>
      ))}
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
        pipsNote={locked != null ? "aman · SL di BE" : running ? "floating" : undefined}
        sub={open ? "Ketuk untuk menutup detail" : s.excluded ? `Tidak dihitung di statistik. ${s.excluded_reason ?? ""}` : running && s.outcome_note ? `${s.outcome_note} Ketuk untuk detail.` : "Ketuk untuk lihat entry, SL & TP"}
        onClick={() => setOpen((v) => !v)}
        active={open}
      />
      {open && <SignalDetails s={s} tz={tz} price={price} extra={extra} />}
    </>
  );
}
