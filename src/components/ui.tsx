"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { FeedStatus } from "@/core/types";
import { FEED_STATUS_LABEL } from "@/lib/market";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

export function fmt(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("id-ID", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtMoney(n: number | null | undefined, ccy = "USD"): string {
  if (n == null || !Number.isFinite(n)) return "—";
  try {
    return n.toLocaleString("id-ID", { style: "currency", currency: ccy, maximumFractionDigits: ccy === "IDR" ? 0 : 2 });
  } catch {
    return `${fmt(n)} ${ccy}`;
  }
}

export function fmtTime(iso: string | null | undefined, tz: string, withDate = false): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("id-ID", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    second: withDate ? undefined : "2-digit",
    day: withDate ? "2-digit" : undefined,
    month: withDate ? "short" : undefined,
    hour12: false,
  });
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function ago(iso: string | null | undefined, now: number): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} dtk lalu`;
  if (s < 3600) return `${Math.floor(s / 60)} mnt lalu`;
  if (s < 86400) return `${Math.floor(s / 3600)} jam lalu`;
  return `${Math.floor(s / 86400)} hari lalu`;
}

const STATUS_STYLE: Record<FeedStatus, string> = {
  live: "border-buy/50 bg-buy/10 text-buy",
  delayed: "border-warn/50 bg-warn/10 text-warn",
  reconnecting: "border-warn/50 bg-warn/10 text-warn",
  disconnected: "border-sell/50 bg-sell/10 text-sell",
  market_closed: "border-muted/40 bg-muted/10 text-muted",
  demo: "border-info/50 bg-info/10 text-info",
};

export function StatusBadge({ status, className }: { status: FeedStatus; className?: string }) {
  return (
    <span className={cx("chip", STATUS_STYLE[status], className)} title={`Status feed: ${FEED_STATUS_LABEL[status]}`}>
      <span className={cx("h-1.5 w-1.5 rounded-full bg-current", status === "live" && "pulse-dot")} />
      {FEED_STATUS_LABEL[status]}
    </span>
  );
}

export function DirBadge({ dir }: { dir: "BUY" | "SELL" }) {
  return <span className={cx("chip font-bold", dir === "BUY" ? "border-buy/50 bg-buy/10 text-buy" : "border-sell/50 bg-sell/10 text-sell")}>{dir}</span>;
}

export function Card({ title, action, children, className }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("card fade-in min-w-0", className)}>
      {(title || action) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="card-title">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "buy" | "sell" | "gold" }) {
  return (
    <div className="min-w-0 rounded-xl border border-line/70 bg-surface-2/60 p-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className={cx("num mt-1 break-words text-base font-semibold leading-snug sm:text-lg", tone === "buy" && "text-buy", tone === "sell" && "text-sell", tone === "gold" && "text-gold")}>{value}</div>
      {sub && <div className="mt-0.5 truncate text-xs text-muted">{sub}</div>}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line p-6 text-center">
      <div className="font-semibold text-ink">{title}</div>
      {children && <div className="mt-1 text-sm text-muted">{children}</div>}
    </div>
  );
}

export function ScoreBar({ score, min }: { score: number; min?: number }) {
  const tone = score >= 75 ? "bg-buy" : score >= (min ?? 60) ? "bg-gold" : "bg-muted";
  return (
    <div className="flex items-center gap-2" title="Skor kualitas berbasis aturan (bukan probabilitas menang)">
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-line">
        <div className={cx("h-full rounded-full", tone)} style={{ width: `${Math.min(100, score)}%` }} />
      </div>
      <span className="num text-xs text-muted">{score}/100</span>
    </div>
  );
}

export function Confirm({
  open,
  title,
  body,
  confirmLabel,
  onConfirm,
  onClose,
  tone = "gold",
  children,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
  tone?: "gold" | "sell";
  children?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-3 sm:items-center" role="dialog" aria-modal="true" aria-label={title}>
      <div className="card w-full max-w-md fade-in">
        <h3 className="text-base font-semibold">{title}</h3>
        <div className="mt-2 text-sm text-muted">{body}</div>
        {children && <div className="mt-3">{children}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose} disabled={busy}>
            Batal
          </button>
          <button
            className={tone === "sell" ? "btn-sell" : "btn-gold"}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Memproses…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Disclaimer({ compact }: { compact?: boolean }) {
  return (
    <p className={cx("text-xs leading-relaxed text-muted", !compact && "rounded-xl border border-line/70 bg-surface-2/50 p-3")}>
      <strong className="text-ink/80">Pemberitahuan:</strong> GOLDMARKET bersifat informasional dan tidak mengeksekusi order ke broker. Analisis, skor, dan
      probabilitas bukan saran investasi dan tidak menjamin hasil. Trading XAUUSD berisiko tinggi; keputusan dan risiko sepenuhnya milik Anda.
    </p>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block min-w-0">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-muted">{hint}</span>}
    </label>
  );
}
