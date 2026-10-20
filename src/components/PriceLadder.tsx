"use client";

import { cx, fmt } from "./ui";
import type { SetupRow } from "@/lib/market";

export type LadderTone = "buy" | "sell" | "ink" | "gold" | "muted";

export interface LadderMark {
  price: number;
  label: string;
  /** keterangan kecil di bawah label, mis. "3 sentuhan" */
  detail?: string;
  /** teks di kanan, mis. "+100 pips" */
  note?: string;
  tone: LadderTone;
  /** zona (low, high) digambar sebagai pita, bukan titik */
  band?: [number, number];
  /** level sudah tersentuh (TP) */
  done?: boolean;
}

const TEXT: Record<LadderTone, string> = { buy: "text-buy", sell: "text-sell", ink: "text-ink", gold: "text-gold", muted: "text-muted" };
const FILL: Record<LadderTone, string> = { buy: "bg-buy", sell: "bg-sell", ink: "bg-ink", gold: "bg-gold", muted: "bg-muted" };

type Row = { kind: "mark"; m: LadderMark } | { kind: "price" };

const ROW_PX = 44;

/**
 * Peta harga vertikal: level diurutkan dari atas (harga tinggi) ke bawah, jarak antarbaris sebanding dengan jarak harga
 * (dengan tinggi baris minimum supaya label tidak bertabrakan). Harga sekarang ditandai emas di posisinya.
 * Bila `anchor` diberikan (entry), rel antara entry dan harga diwarnai hijau/merah sesuai untung/rugi posisi.
 */
export function PriceLadder({
  marks,
  price,
  priceNote,
  anchor,
  direction,
  spread = 150,
  empty,
}: {
  marks: LadderMark[];
  price: number | null;
  priceNote?: string;
  anchor?: number;
  direction?: "BUY" | "SELL";
  /** tinggi tambahan (px) yang dibagi sebanding jarak harga */
  spread?: number;
  empty?: string;
}) {
  const rows: Row[] = marks.map((m) => ({ kind: "mark", m }));
  if (price != null) rows.push({ kind: "price" });
  const at = (r: Row) => (r.kind === "price" ? (price as number) : r.m.price);
  // harga sekarang diletakkan di atas level yang sama persis supaya tetap terbaca
  rows.sort((a, b) => at(b) - at(a) || (a.kind === "price" ? -1 : b.kind === "price" ? 1 : 0));
  const hi = rows.length ? at(rows[0]) : 0;
  const lo = rows.length ? at(rows[rows.length - 1]) : 0;
  const span = hi - lo || 1;
  const gap = (i: number) => (i === 0 ? 0 : Math.round(((at(rows[i - 1]) - at(rows[i])) / span) * spread));

  // segmen rel antara entry dan harga sekarang
  const lit = anchor != null && price != null ? ([Math.min(anchor, price), Math.max(anchor, price)] as const) : null;
  const profit = lit && direction ? (direction === "BUY" ? (price as number) >= (anchor as number) : (price as number) <= (anchor as number)) : null;
  const litTone = profit == null ? "bg-gold/60" : profit ? "bg-buy/70" : "bg-sell/70";
  const segLit = (a: number, b: number) => lit != null && Math.min(a, b) >= lit[0] - 1e-9 && Math.max(a, b) <= lit[1] + 1e-9 && a !== b;

  return (
    <div className="relative max-w-xl" role="list">
      {rows.map((r, i) => {
        const g = gap(i);
        const prev = i > 0 ? at(rows[i - 1]) : null;
        const next = i < rows.length - 1 ? at(rows[i + 1]) : null;
        const p = at(r);
        return (
          <div key={r.kind === "price" ? "price" : `${r.m.label}-${r.m.price}`} role="listitem" className="grid grid-cols-[4.75rem_1.25rem_minmax(0,1fr)_auto] items-stretch gap-x-2 sm:grid-cols-[5.5rem_1.5rem_minmax(0,1fr)_auto]" style={{ paddingTop: g }}>
            {/* kolom harga */}
            <div className={cx("num flex items-center justify-end text-[13px] tabular-nums", r.kind === "price" ? "font-bold text-gold-strong" : cx("font-medium", TEXT[r.m.tone]))} style={{ minHeight: ROW_PX }}>
              {fmt(p)}
            </div>
            {/* rel */}
            <div className="relative" style={{ marginTop: -g }}>
              {prev != null && <span className={cx("absolute left-1/2 top-0 w-px -translate-x-1/2", segLit(prev, p) ? cx("w-[3px]", litTone) : "bg-line")} style={{ height: g + ROW_PX / 2 }} />}
              {next != null && <span className={cx("absolute bottom-0 left-1/2 w-px -translate-x-1/2", segLit(p, next) ? cx("w-[3px]", litTone) : "bg-line")} style={{ top: g + ROW_PX / 2 }} />}
              <span className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2" style={{ top: g + ROW_PX / 2 }}>
                {r.kind === "price" ? (
                  <span className="block h-3.5 w-3.5 rounded-full border-2 border-gold-strong bg-bg shadow-[0_0_0_4px_rgb(232_184_76/0.15)]" />
                ) : r.m.band ? (
                  <span className={cx("block h-5 w-2 rounded-sm opacity-80", FILL[r.m.tone])} />
                ) : (
                  <span className={cx("block h-2 w-2 rounded-full", r.m.done ? FILL[r.m.tone] : cx("border-2 bg-bg", r.m.tone === "buy" ? "border-buy" : r.m.tone === "sell" ? "border-sell" : r.m.tone === "gold" ? "border-gold" : r.m.tone === "ink" ? "border-ink" : "border-muted"))} />
                )}
              </span>
            </div>
            {/* label */}
            <div className="flex min-w-0 flex-col justify-center py-1" style={{ minHeight: ROW_PX }}>
              {r.kind === "price" ? (
                <span className="text-sm font-semibold text-gold-strong">Harga sekarang</span>
              ) : (
                <>
                  <span className={cx("truncate text-sm", r.m.done ? "font-semibold text-buy" : "text-ink")}>
                    {r.m.label}
                    {r.m.done && " tersentuh"}
                  </span>
                  {r.m.detail && <span className="truncate text-xs text-muted">{r.m.detail}</span>}
                </>
              )}
            </div>
            <div className="num flex items-center justify-end text-right text-xs text-muted" style={{ minHeight: ROW_PX }}>
              {r.kind === "price" ? priceNote : r.m.note}
            </div>
          </div>
        );
      })}
      {marks.length === 0 && empty && <p className="mt-2 pl-[7rem] text-xs text-muted sm:pl-[8rem]">{empty}</p>}
    </div>
  );
}

type SignalLevels = Pick<SetupRow, "direction" | "entry_type" | "entry_price" | "entry_low" | "entry_high" | "sl" | "sl_pips" | "tp1" | "tp2" | "tp3" | "rr" | "invalidation" | "pip_size" | "outcome_tp">;

const ORDER_LABEL: Record<SetupRow["entry_type"], string> = { market: "market", limit: "limit", stop: "stop" };

/** Level sinyal (SL · Entry · TP1–TP3) untuk PriceLadder. Setelah TP1, SL ada di entry (BE) sehingga baris SL dihilangkan. */
export function signalMarks(s: SignalLevels, opts: { invalidation?: boolean } = {}): LadderMark[] {
  const pip = s.pip_size || 0.1;
  const tpHit = s.outcome_tp ?? 0;
  const pips = (p: number) => fmt(Math.abs(p - s.entry_price) / pip, 0);
  const marks: LadderMark[] = ([s.tp1, s.tp2, s.tp3] as const).map((p, i) => ({
    price: p,
    label: `TP${i + 1}`,
    detail: s.rr ? `RR ${fmt([s.rr.tp1, s.rr.tp2, s.rr.tp3][i], 1)}` : undefined,
    note: `+${pips(p)} pips`,
    tone: "buy",
    done: tpHit >= i + 1,
  }));
  marks.push({
    price: s.entry_price,
    label: `Entry ${ORDER_LABEL[s.entry_type]}`,
    detail: tpHit >= 1 ? "SL sudah dipindah ke sini (BE)" : `Area ${fmt(s.entry_low)}–${fmt(s.entry_high)}`,
    tone: tpHit >= 1 ? "gold" : "ink",
    band: [s.entry_low, s.entry_high],
  });
  if (tpHit < 1) marks.push({ price: s.sl, label: "Stop loss", note: `−${fmt(s.sl_pips, 0)} pips`, tone: "sell" });
  if (opts.invalidation && s.invalidation != null && Math.abs(s.invalidation - s.sl) > pip / 2)
    marks.push({ price: s.invalidation, label: "Invalidasi", detail: "Setup batal bila ditembus", tone: "muted" });
  return marks;
}
