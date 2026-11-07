"use client";

import { ago, cx } from "./ui";
import type { EconEventRow, NewsRow, UsdBiasRow } from "@/lib/market";
import { eventBias, type EventBias } from "@/core/eventBias";
import type { UsdSide } from "@/core/usdBias";

const USD_TEXT: Record<UsdSide, { text: string; cls: string }> = {
  BULLISH: { text: "Bullish USD", cls: "text-buy" },
  BEARISH: { text: "Bearish USD", cls: "text-sell" },
  NETRAL: { text: "USD netral", cls: "text-muted" },
};
const XAU_TEXT: Record<EventBias["side"], string> = { BUY: "text-buy", SELL: "text-sell", NETRAL: "text-muted" };

/** Dua kotak "AI BIAS (USD)" dan "XAUUSD SIGNAL". */
function BiasPair({ usd, xau, strength, small }: { usd: UsdSide; xau: EventBias["side"]; strength: string | null; small?: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <div className="rounded-xl border border-line/70 bg-bg/40 p-2.5">
        <div className="text-[10px] font-medium uppercase tracking-wider text-muted">Bias USD</div>
        <div className={cx("font-bold", small ? "text-base" : "text-xl", USD_TEXT[usd].cls)}>{USD_TEXT[usd].text}</div>
      </div>
      <div className="rounded-xl border border-line/70 bg-bg/40 p-2.5">
        <div className="text-[10px] font-medium uppercase tracking-wider text-muted">Sinyal XAUUSD</div>
        <div className={cx("font-bold", small ? "text-base" : "text-xl", XAU_TEXT[xau])}>
          {xau === "NETRAL" ? "Netral" : xau === "BUY" ? "Buy" : "Sell"}
          {strength && <span className="ml-1 text-xs font-normal text-muted">({strength})</span>}
        </div>
      </div>
    </div>
  );
}

/** Kartu "Arah USD & XAUUSD hari ini" (engine mode news, tiap 15 menit). */
export function UsdBiasCard({ b, now, compact }: { b: UsdBiasRow | null | undefined; now: number; compact?: boolean }) {
  if (!b) return null;
  return (
    <div className="rounded-2xl border border-gold/40 bg-gold/5 p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted">Arah hari ini · XAUUSD</span>
        <span className="ml-auto text-[11px] text-muted">diperbarui {ago(b.computed_at, now)}</span>
      </div>
      <BiasPair usd={b.usd_side} xau={b.xau_side} strength={b.strength} small={compact} />
      {!compact && (
        <>
          <ul className="mt-3 list-disc space-y-0.5 pl-5 text-xs">
            {b.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">
            Penentu utama = tren EUR/USD M15 &amp; H1 (EUR/USD turun = USD menguat); berita USD 24 jam &amp; tren XAU M15/H1 hanya konfirmasi; XAUUSD = kebalikan USD. Berbasis aturan, belum teruji — konteks, bukan sinyal entry. Bukan saran investasi.
          </p>
        </>
      )}
    </div>
  );
}

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
export function NextEvent({ ev, now, tz, events, news, usd, compact }: { ev: EconEventRow | null; now: number; tz: string; events?: EconEventRow[] | null; news?: NewsRow[] | null; usd?: UsdBiasRow | null; compact?: boolean }) {
  if (!ev) {
    return (
      <div className="rounded-2xl border border-line bg-surface-2/50 p-4 text-sm text-muted">
        Tidak ada lagi jadwal FOMC, NFP, CPI, atau PPI di kalender minggu ini. Jadwal minggu depan muncul otomatis saat sumber memperbarui kalender (awal minggu, Minggu).
      </div>
    );
  }
  const ms = Date.parse(ev.time_at) - now;
  const soon = ms <= 30 * 60 * 1000;
  // arah USD ≤1 jam = penentu utama (sama dengan engine)
  const usdFresh = usd && now - Date.parse(usd.computed_at) <= 3600_000 ? { usd: usd.usd_side, strength: usd.strength } : null;
  const b = eventBias(releaseOf(ev, events), news ?? [], now, usdFresh);
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
      <div className="mt-3">
        <BiasPair usd={b.usd} xau={b.side} strength={b.strength} small={compact} />
      </div>
      <div className={cx("mt-2 rounded-xl border border-line/70 bg-bg/40 p-3 text-xs", compact && "hidden")}>
        {!compact && (
          <>
            <div className="font-semibold text-muted">Alasan perkiraan sebelum rilis</div>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {b.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
            {b.scenario && <p className="mt-2 text-ink/90">{b.scenario}</p>}
            <p className="mt-2 text-muted">
              Berbasis aturan (arah USD hari ini sebagai penentu, forecast vs previous + nada berita 72 jam sebagai pendukung), belum teruji — lihat tab Riwayat Prediksi. Forecast biasanya sudah diperhitungkan pasar; gerak terbesar datang dari selisih <b>actual vs forecast</b>, dan angka actual belum tersedia di sumber. Bukan saran investasi.
            </p>
          </>
        )}
      </div>
      {soon && <p className="mt-2 text-xs text-sell">Volatilitas bisa tinggi &amp; spread melebar. Pertimbangkan menunda entry atau memperketat manajemen risiko.</p>}
    </div>
  );
}
