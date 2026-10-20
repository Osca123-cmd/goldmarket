"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { cx, fmt } from "./ui";
import { SignalBar } from "./LevelBar";
import { STRATEGY_LABEL } from "@/core/config";
import { floatingPips, isRunningSignal, type SetupRow } from "@/lib/market";

export type ResultKind = "win" | "loss" | "be" | "open" | "timeout" | "cancelled" | "running" | "tp1" | "tp2" | "excluded";

// accent = garis warna di tepi kiri kartu (hasil akhir; sinyal yang masih berjalan biru)
const RESULT: Record<ResultKind, { label: string; text: string; accent: string }> = {
  win: { label: "Menang", text: "text-buy", accent: "border-l-buy" },
  loss: { label: "Kalah", text: "text-sell", accent: "border-l-sell" },
  be: { label: "Impas (BE)", text: "text-muted", accent: "border-l-muted" },
  open: { label: "Terbuka", text: "text-info", accent: "border-l-info" },
  timeout: { label: "Ditutup 24 jam", text: "text-warn", accent: "border-l-warn" },
  cancelled: { label: "Batal", text: "text-muted", accent: "border-l-line" },
  running: { label: "Berjalan", text: "text-info", accent: "border-l-info" },
  tp1: { label: "TP1 tersentuh", text: "text-buy", accent: "border-l-info" },
  tp2: { label: "TP2 tersentuh", text: "text-buy", accent: "border-l-info" },
  excluded: { label: "Dikecualikan", text: "text-muted", accent: "border-l-line" },
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
  detail,
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
  /** isi yang dibuka di dalam kartu yang sama */
  detail?: ReactNode;
}) {
  const r = RESULT[result];
  const Tag = onClick ? "button" : "div";
  return (
    <div className={cx("overflow-hidden rounded-xl border-l-4 bg-surface-2", r.accent, (result === "excluded" || result === "cancelled") && "opacity-75")}>
      <Tag
        onClick={onClick}
        aria-expanded={onClick ? !!active : undefined}
        className={cx("flex w-full items-start gap-3 px-3.5 py-3 text-left transition", onClick && "hover:bg-white/[0.03] focus-visible:bg-white/[0.04] focus-visible:outline-none")}
      >
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
          <span className={cx("block text-xs font-semibold", r.text)}>{r.label}</span>
          {pipsNote && <span className="block text-[11px] text-muted">{pipsNote}</span>}
        </span>
      </Tag>
      {active && detail}
    </div>
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
      <div className="space-y-2 px-3 pb-3 sm:px-4 sm:pb-4">{children}</div>
    </section>
  );
}

/** Detail sinyal (bar level entry, SL, TP) — dibuka dengan mengetuk baris riwayat. */
export function SignalDetails({ s, tz, price, extra }: { s: SetupRow; tz: string; price: number | null; extra?: ReactNode }) {
  const t = (iso: string | null) => (iso ? new Date(iso).toLocaleString("id-ID", { timeZone: tz, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
  const pip = s.pip_size || 0.1;
  const running = isRunningSignal(s);
  const tpHit = s.outcome_tp ?? 0;
  const float = running && price != null ? floatingPips(s.direction, s.entry_price, price, pip) : null;
  const locked = tpHit > 0 ? Math.abs([s.tp1, s.tp2, s.tp3][tpHit - 1] - s.entry_price) / pip : null;
  return (
    <div className="space-y-3 border-t border-line/70 px-3 pb-4 pt-3">
      <p className="text-xs text-muted">
        {STRATEGY_LABEL[s.strategy]}, {s.timeframe} dengan konfirmasi {s.confirm_tf}, skor {s.score}/100. Dibuat {t(s.created_at)}, entry tersentuh {t(s.entry_touched_at)}.
      </p>
      <SignalBar s={s} price={running ? price : null} priceText={float != null ? `${float > 0 ? "+" : ""}${fmt(float, 1)} pips` : undefined} />
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
        detail={<SignalDetails s={s} tz={tz} price={price} extra={extra} />}
      />
  );
}
