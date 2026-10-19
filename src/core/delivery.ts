import type { EngineConfig, DeliveryWindow } from "./config.ts";
import type { EntryType } from "./types.ts";
import type { StoredSetup } from "./setups.ts";

/**
 * Aturan PENGIRIMAN sinyal live (permintaan pengguna, 19 Okt 2026). Tidak mengubah deteksi, SL/TP,
 * maupun backtest; kandidat yang ditahan tidak disimpan sehingga bisa muncul lagi bila masih valid.
 *  - oneAtATime: tidak ada sinyal baru selama masih ada sinyal hidup — READY layak yang belum kena
 *    entry, atau sinyal berjalan yang belum TP1. Setelah TP1 (SL di BE) antrean bebas.
 *  - entryTypes: hanya jenis entry ini yang dikirim (20 Okt: entry stop dinonaktifkan, hasil live buruk).
 *  - windows: di jam lokal [startHour, endHour) hanya jenis entry tertentu, maks N sinyal per hari.
 */
export function isQueueBlocking(s: StoredSetup): boolean {
  if (s.status === "approaching" || s.status === "awaiting_confirmation") return s.eligible;
  return s.status === "entry_touched" && (s.outcome == null || s.outcome === "open") && !(s.outcome_tp ?? 0);
}

/** Hari lokal (angka hari sejak epoch) dan jam lokal untuk offset UTC tetap (WIB tanpa DST). */
function local(sec: number, w: DeliveryWindow): { day: number; hour: number } {
  const t = sec + w.utcOffsetHours * 3600;
  return { day: Math.floor(t / 86400), hour: Math.floor((t % 86400) / 3600) };
}

const inWindow = (sec: number, w: DeliveryWindow) => {
  const h = local(sec, w).hour;
  return h >= w.startHour && h < w.endHour;
};

export function deliveryBlock(
  c: { entryType: EntryType },
  known: StoredSetup[],
  cfg: Pick<EngineConfig, "delivery">,
  nowSec: number,
): string | null {
  const rules = cfg.delivery;
  if (!rules) return null;
  if (rules.entryTypes && !rules.entryTypes.includes(c.entryType)) return `Entry ${c.entryType} dinonaktifkan (hanya ${rules.entryTypes.join("/")}).`;
  if (rules.oneAtATime) {
    const live = known.find(isQueueBlocking);
    if (live) return `Menunggu sinyal ${live.direction} ${live.timeframe} ${live.entry_price.toFixed(2)} selesai atau mencapai TP1 (1 sinyal sekaligus).`;
  }
  for (const w of rules.windows ?? []) {
    if (!inWindow(nowSec, w)) continue;
    if (!w.entryTypes.includes(c.entryType)) return `Jam ${w.label}: hanya entry ${w.entryTypes.join("/")}, entry ${c.entryType} tidak dikirim.`;
    const today = local(nowSec, w).day;
    const sent = known.filter((s) => s.eligible && inWindow(s.created_at_sec, w) && local(s.created_at_sec, w).day === today).length;
    if (sent >= w.maxPerDay) return `Jam ${w.label}: maks ${w.maxPerDay} sinyal per hari sudah terpakai.`;
  }
  return null;
}
