"use client";

import { cx, fmt } from "./ui";
import type { SetupRow } from "@/lib/market";

type SignalLevels = Pick<SetupRow, "direction" | "entry_type" | "entry_price" | "sl" | "sl_pips" | "tp1" | "tp2" | "tp3" | "pip_size" | "outcome" | "outcome_tp">;

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const pct = (t: number) => `${t * 100}%`;

/** Gelembung emas + tangkai di atas bar; gelembung ditahan di dalam bar supaya tidak terpotong di tepi. */
function Pin({ at, text, muted }: { at: number; text: string; muted?: boolean }) {
  return (
    <>
      <span
        className={cx("num absolute -top-10 -translate-x-1/2 whitespace-nowrap rounded-lg px-2 py-1 text-xs font-extrabold", muted ? "border border-line bg-surface-2 text-ink" : "bg-gold text-bg")}
        style={{ left: pct(clamp(at, muted ? 0.24 : 0.14, muted ? 0.76 : 0.86)) }}
      >
        {text}
      </span>
      <span className={cx("absolute -top-3 h-[18px] w-0.5 -translate-x-1/2", muted ? "bg-muted" : "bg-gold")} style={{ left: pct(at) }} aria-hidden />
    </>
  );
}

/**
 * Bar progres sinyal: kiri SL, kanan TP3 (searah untung, untuk BUY maupun SELL). Sisi rugi merah, sisi untung hijau,
 * bagian antara entry dan harga sekarang diisi; tanpa harga (riwayat selesai) diisi sampai TP tertinggi / SL.
 * Belum kena entry (`entered` false): tidak ada isian — posisi harga hanya ditandai netral, supaya tidak terlihat seperti floating.
 */
export function SignalBar({ s, price, priceText, entered = true }: { s: SignalLevels; price: number | null; priceText?: string; entered?: boolean }) {
  const d = s.direction === "BUY" ? 1 : -1;
  const full = d * (s.tp3 - s.sl) || 1;
  const at = (p: number) => clamp((d * (p - s.sl)) / full);
  const tpHit = s.outcome_tp ?? 0;
  const tEntry = at(s.entry_price);
  const tEnd = !entered ? tEntry : price != null ? at(price) : tpHit > 0 ? at([s.tp1, s.tp2, s.tp3][tpHit - 1]) : s.outcome === "loss" ? 0 : tEntry;
  const gain = tEnd >= tEntry;
  const pip = s.pip_size || 0.1;
  const ticks = [
    { t: 0, label: tpHit >= 1 ? "SL (BE)" : "SL", hit: false },
    { t: tEntry, label: "Entry", hit: false },
    { t: at(s.tp1), label: "TP1", hit: tpHit >= 1 },
    { t: at(s.tp2), label: "TP2", hit: tpHit >= 2 },
    { t: 1, label: "TP3", hit: tpHit >= 3 },
  ];
  const tiles = [
    tpHit >= 1
      ? { k: "SL → BE", v: s.entry_price, n: "aman", cls: "text-gold" }
      : { k: "SL", v: s.sl, n: `−${fmt(s.sl_pips, 0)}`, cls: "text-sell" },
    { k: "Entry", v: s.entry_price, n: s.entry_type, cls: "text-muted" },
    ...([s.tp1, s.tp2, s.tp3] as const).map((v, i) => ({ k: `TP${i + 1}${tpHit >= i + 1 ? " ✓" : ""}`, v, n: `+${fmt(Math.abs(v - s.entry_price) / pip, 0)}`, cls: tpHit >= i + 1 ? "text-buy" : "text-muted", hit: tpHit >= i + 1 })),
  ];
  return (
    <div className="@container max-w-2xl">
      <div className={cx("relative mx-1 mb-8", price != null ? "mt-12" : "mt-3")}>
        <div className="relative flex h-3 overflow-hidden rounded-full bg-surface-2">
          <span className="h-full bg-sell/30" style={{ width: pct(tEntry) }} />
          <span className="h-full flex-1 bg-buy/15" />
          {tEnd !== tEntry && (
            <span
              className={cx("absolute inset-y-0", gain ? "bg-gradient-to-r from-buy/55 to-buy" : "bg-gradient-to-l from-sell/55 to-sell")}
              style={{ left: pct(Math.min(tEntry, tEnd)), width: pct(Math.abs(tEnd - tEntry)) }}
            />
          )}
        </div>
        {ticks.slice(1, 4).map((k) => (
          <span key={k.label} className={cx("absolute -top-1 h-5 w-0.5 -translate-x-1/2", k.hit ? "bg-buy" : "bg-line")} style={{ left: pct(k.t) }} aria-hidden />
        ))}
        {ticks.map((k, i) => (
          <span
            key={k.label}
            className={cx("absolute top-6 whitespace-nowrap text-[11px] font-semibold", k.hit ? "text-buy" : "text-muted", i === 0 ? "left-0" : i === 4 ? "right-0" : "-translate-x-1/2")}
            style={i === 0 || i === 4 ? undefined : { left: pct(k.t) }}
          >
            {k.label}
            {k.hit && " ✓"}
          </span>
        ))}
        {price != null && <Pin at={at(price)} text={entered ? (priceText ?? fmt(price)) : `${fmt(price)} · belum entry`} muted={!entered} />}
      </div>
      {!entered && price != null && (
        <p className="mb-3 text-xs text-muted">
          Belum kena entry — floating, TP, dan BE mulai dihitung setelah harga menyentuh entry <span className="num text-ink">{fmt(s.entry_price)}</span> ({fmt(Math.abs(price - s.entry_price) / pip, 0)} pips lagi).
        </p>
      )}
      <div className="grid grid-cols-3 gap-1 @[17rem]:grid-cols-5">
        {tiles.map((t) => (
          <div key={t.k} className={cx("min-w-0 rounded-xl px-1 py-2 text-center", "hit" in t && t.hit ? "bg-buy/15" : "bg-surface-2")}>
            <div className={cx("truncate text-[11px] font-semibold", t.cls)}>{t.k}</div>
            <div className="num truncate text-[10.5px] font-bold tracking-tighter text-ink">{fmt(t.v)}</div>
            <div className="num truncate text-[10.5px] text-muted">{t.n}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export interface BarZone {
  low: number;
  high: number;
  mid: number;
  tf: string;
  touches: number;
  dist: number;
}

/** Posisi harga di antara zona support terdekat (kiri) dan resistance terdekat (kanan). */
export function ZoneBar({ support, resistance, price, pipSize }: { support: BarZone | null; resistance: BarZone | null; price: number; pipSize: number }) {
  const side = (z: BarZone | null, kind: "support" | "resistance") => (
    <div className={cx("min-w-0", kind === "resistance" && "text-right")}>
      <div className={cx("text-sm font-semibold", kind === "support" ? "text-buy" : "text-sell")}>
        {kind === "support" ? "Support" : "Resistance"} {z?.tf ?? ""}
      </div>
      {z ? (
        <>
          <div className="num text-sm font-bold text-ink">{fmt(z.mid)}</div>
          <div className="text-xs text-muted">{z.dist === 0 ? "harga di dalam zona" : `${fmt(z.dist, 0)} pips di ${kind === "support" ? "bawah" : "atas"}`}</div>
        </>
      ) : (
        <div className="text-xs text-muted">Belum ada level ≥2 sentuhan</div>
      )}
    </div>
  );
  const lo = support ? support.low : price - 40 * pipSize;
  const hi = resistance ? resistance.high : price + 40 * pipSize;
  const span = hi - lo || 1;
  const w = (z: BarZone) => pct(clamp((z.high - z.low) / span, 0.08, 0.3));
  return (
    <div className="max-w-2xl">
      <div className="relative mx-1 mb-3 mt-12">
        <div className="relative h-3.5 overflow-hidden rounded-full bg-surface-2">
          {support && <span className="absolute inset-y-0 left-0 bg-buy/55" style={{ width: w(support) }} />}
          {resistance && <span className="absolute inset-y-0 right-0 bg-sell/55" style={{ width: w(resistance) }} />}
        </div>
        <Pin at={clamp((price - lo) / span)} text={fmt(price)} />
      </div>
      <div className="flex justify-between gap-3">
        {side(support, "support")}
        {side(resistance, "resistance")}
      </div>
    </div>
  );
}
