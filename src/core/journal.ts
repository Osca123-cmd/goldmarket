import type { Direction } from "./types.ts";
import { pnlForMove } from "./risk.ts";

export type JournalStatus = "open" | "closed" | "cancelled";
export type JournalOutcome = "tp1" | "tp2" | "tp3" | "sl" | "be" | "manual";

export interface JournalTrade {
  id: string;
  user_id?: string;
  setup_id: string | null;
  direction: Direction;
  strategy: string;
  timeframe: string;
  session: string;
  entry_price: number;
  lot: number;
  initial_sl: number;
  sl: number;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  opened_at: string;
  closed_at: string | null;
  status: JournalStatus;
  outcome: JournalOutcome | null;
  tp1_hit_at: string | null;
  tp2_hit_at: string | null;
  tp3_hit_at: string | null;
  commission: number;
  swap: number;
  contract_size: number;
  quote_to_account_rate: number;
  notes: string | null;
}

export interface JournalPartial {
  id: string;
  trade_id: string;
  closed_at: string;
  lot: number;
  price: number;
  kind: "partial" | "final";
  note?: string | null;
}

export const OUTCOME_LABEL: Record<JournalOutcome, string> = {
  tp1: "Ditutup di TP1",
  tp2: "Ditutup di TP2",
  tp3: "Ditutup di TP3",
  sl: "Kena SL",
  be: "Break-even (BE)",
  manual: "Ditutup manual",
};

export const STATUS_LABEL: Record<JournalStatus, string> = {
  open: "Terbuka",
  closed: "Selesai",
  cancelled: "Dibatalkan",
};

export function partialPnl(t: JournalTrade, p: JournalPartial): number {
  return pnlForMove(t.direction, t.entry_price, p.price, p.lot, t.contract_size, t.quote_to_account_rate);
}

export function closedLot(partials: JournalPartial[]): number {
  return Math.round(partials.reduce((a, p) => a + p.lot, 0) * 1e6) / 1e6;
}

export function remainingLot(t: JournalTrade, partials: JournalPartial[]): number {
  return Math.max(0, Math.round((t.lot - closedLot(partials)) * 1e6) / 1e6);
}

/** Profit/loss terealisasi bersih = Σ PnL partial − komisi − swap. */
export function realizedPnl(t: JournalTrade, partials: JournalPartial[]): { gross: number; fees: number; net: number } {
  const gross = partials.filter((p) => p.trade_id === t.id).reduce((a, p) => a + partialPnl(t, p), 0);
  const fees = (t.commission || 0) + (t.swap || 0);
  return { gross, fees, net: gross - fees };
}

/** Risiko awal (mata uang akun) dari SL AWAL — bukan SL setelah dipindah ke BE. */
export function initialRisk(t: JournalTrade): number {
  return Math.abs(t.entry_price - t.initial_sl) * t.contract_size * t.lot * t.quote_to_account_rate;
}

export function rMultiple(t: JournalTrade, net: number): number | null {
  const r = initialRisk(t);
  return r > 0 ? net / r : null;
}

/**
 * Pengingat (bukan aksi otomatis): TP1 tersentuh menurut feed pada transaksi terbuka.
 * Aplikasi TIDAK mengubah SL/status jurnal; pengguna yang mengonfirmasi.
 */
export function tp1ReachedByFeed(t: JournalTrade, price: number | null): boolean {
  if (t.status !== "open" || t.tp1 == null || price == null || t.tp1_hit_at) return false;
  return t.direction === "BUY" ? price >= t.tp1 : price <= t.tp1;
}

export type JournalAction =
  | { type: "milestone"; milestone: "tp1" | "tp2" | "tp3" }
  | { type: "move_sl"; sl: number }
  | { type: "partial"; lot: number; price: number }
  | { type: "close"; outcome: JournalOutcome; price: number }
  | { type: "cancel" };

/** Validasi aksi jurnal sebelum dikirim (server juga memvalidasi lewat constraint/trigger). */
export function validateAction(t: JournalTrade, partials: JournalPartial[], a: JournalAction): string | null {
  if (t.status !== "open") return "Transaksi sudah tidak terbuka.";
  const rem = remainingLot(t, partials);
  switch (a.type) {
    case "milestone":
      if (t[`${a.milestone}_hit_at` as const]) return `${a.milestone.toUpperCase()} sudah ditandai.`;
      if (t[a.milestone] == null) return `${a.milestone.toUpperCase()} tidak diisi pada transaksi ini.`;
      return null;
    case "move_sl":
      return a.sl > 0 ? null : "SL tidak valid.";
    case "partial":
      if (!(a.lot > 0)) return "Lot partial harus > 0.";
      if (a.lot >= rem) return `Lot partial harus lebih kecil dari sisa lot (${rem}). Gunakan "Tutup" untuk menutup sisa.`;
      return a.price > 0 ? null : "Harga partial tidak valid.";
    case "close":
      return a.price > 0 ? null : "Harga penutupan tidak valid.";
    case "cancel":
      return partials.length > 0 ? "Transaksi dengan partial close tidak dapat dibatalkan; tutup secara manual." : null;
  }
}
