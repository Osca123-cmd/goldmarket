"use client";

import { cx } from "./ui";
import type { EconEventRow } from "@/lib/market";

export function countdown(ms: number): string {
  if (ms <= 0) return "sudah rilis";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} hr ${h} j`;
  if (h > 0) return `${h} j ${String(m).padStart(2, "0")} m`;
  return `${m} m ${String(s % 60).padStart(2, "0")} d`;
}

export function dayKey(iso: string, tz: string) {
  return new Date(iso).toLocaleDateString("id-ID", { timeZone: tz, weekday: "long", day: "2-digit", month: "long" });
}

export function hm(iso: string, tz: string) {
  return new Date(iso).toLocaleTimeString("id-ID", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Kartu hitung mundur ke event USD berdampak tinggi berikutnya (kalender ekonomi). */
export function NextEvent({ ev, now, tz }: { ev: EconEventRow | null; now: number; tz: string }) {
  if (!ev) {
    return (
      <div className="rounded-2xl border border-line bg-surface-2/50 p-4 text-sm text-muted">
        Tidak ada lagi jadwal FOMC, NFP, CPI, atau PPI di kalender minggu ini. Jadwal minggu depan muncul otomatis saat sumber memperbarui kalender (awal minggu, Minggu).
      </div>
    );
  }
  const ms = Date.parse(ev.time_at) - now;
  const soon = ms <= 30 * 60 * 1000;
  return (
    <div className={cx("rounded-2xl border p-4", soon ? "border-sell/60 bg-sell/10" : "border-gold/40 bg-gold/5")}>
      <div className="flex flex-wrap items-center gap-3">
        <span className={cx("grid h-10 w-10 shrink-0 place-items-center rounded-xl text-lg", soon ? "bg-sell/20 text-sell" : "bg-gold/15 text-gold")} aria-hidden>
          ⚠️
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted">Rilis berikutnya{ev.topic ? ` · ${ev.topic}` : ""} (USD)</div>
          <div className="break-words font-semibold">{ev.title}</div>
          <div className="text-xs text-muted">
            {dayKey(ev.time_at, tz)} · {hm(ev.time_at, tz)} · forecast {ev.forecast ?? "—"} · previous {ev.previous ?? "—"}
          </div>
        </div>
        <div className={cx("num text-right text-2xl font-bold", soon ? "text-sell" : "text-gold")}>{countdown(ms)}</div>
      </div>
      {soon && <p className="mt-2 text-xs text-sell">Volatilitas bisa tinggi &amp; spread melebar. Pertimbangkan menunda entry atau memperketat manajemen risiko.</p>}
    </div>
  );
}
