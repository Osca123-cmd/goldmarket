"use client";

import { cx } from "./ui";
import type { EconEventRow, NewsRow } from "@/lib/market";
import { eventBias, type EventBias } from "@/core/eventBias";

const SIDE: Record<EventBias["side"], { text: string; cls: string }> = {
  BUY: { text: "▲ BUY", cls: "border-buy/50 bg-buy/10 text-buy" },
  SELL: { text: "▼ SELL", cls: "border-sell/50 bg-sell/10 text-sell" },
  NETRAL: { text: "● NETRAL", cls: "border-muted/40 bg-muted/10 text-muted" },
};

/** Chip arah perkiraan sebelum rilis. */
export function EventBiasChip({ b, className }: { b: EventBias; className?: string }) {
  const s = SIDE[b.side];
  return (
    <span className={cx("chip font-bold", s.cls, className)} title={[...b.reasons, b.scenario].filter(Boolean).join("\n")}>
      {s.text}
      {b.strength && <span className="font-normal opacity-80">· {b.strength}</span>}
    </span>
  );
}

/** Event yang rilis bersamaan dengan `ev` (paket NFP, FOMC statement + rate, …). */
export function releaseOf(ev: EconEventRow, events: EconEventRow[] | null | undefined): EconEventRow[] {
  const same = (events ?? []).filter((e) => e.time_at === ev.time_at && e.topic === ev.topic);
  return same.length ? same : [ev];
}

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
export function NextEvent({ ev, now, tz, events, news, compact }: { ev: EconEventRow | null; now: number; tz: string; events?: EconEventRow[] | null; news?: NewsRow[] | null; compact?: boolean }) {
  if (!ev) {
    return (
      <div className="rounded-2xl border border-line bg-surface-2/50 p-4 text-sm text-muted">
        Tidak ada lagi jadwal FOMC, NFP, CPI, atau PPI di kalender minggu ini. Jadwal minggu depan muncul otomatis saat sumber memperbarui kalender (awal minggu, Minggu).
      </div>
    );
  }
  const ms = Date.parse(ev.time_at) - now;
  const soon = ms <= 30 * 60 * 1000;
  const b = eventBias(releaseOf(ev, events), news ?? [], now);
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
      <div className={cx("mt-3 rounded-xl border border-line/70 bg-bg/40 p-3 text-xs", compact && "p-2")}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted">Perkiraan arah XAUUSD sebelum rilis:</span>
          <EventBiasChip b={b} />
        </div>
        {!compact && (
          <>
            <ul className="mt-2 list-disc space-y-0.5 pl-5">
              {b.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
            {b.scenario && <p className="mt-2 text-ink/90">{b.scenario}</p>}
            <p className="mt-2 text-muted">
              Berbasis aturan (forecast vs previous + nada berita 72 jam), belum teruji — forecast biasanya sudah diperhitungkan pasar; gerak terbesar datang dari selisih <b>actual vs forecast</b>, dan angka actual belum tersedia di sumber. Bukan saran investasi.
            </p>
          </>
        )}
      </div>
      {soon && <p className="mt-2 text-xs text-sell">Volatilitas bisa tinggi &amp; spread melebar. Pertimbangkan menunda entry atau memperketat manajemen risiko.</p>}
    </div>
  );
}
