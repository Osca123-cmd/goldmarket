import type { EngineConfig, DeliveryWindow, QuietHours } from "./config.ts";
import type { EntryType, StopKind } from "./types.ts";
import type { StoredSetup } from "./setups.ts";

/**
 * Aturan PENGIRIMAN sinyal live (permintaan pengguna, 19 Okt 2026). Tidak mengubah deteksi, SL/TP,
 * maupun backtest; kandidat yang ditahan tidak disimpan sehingga bisa muncul lagi bila masih valid.
 *  - oneAtATime: tidak ada sinyal baru selama masih ada sinyal hidup — READY layak yang belum kena
 *    entry, atau sinyal berjalan yang belum TP1. Setelah TP1 (SL di BE) antrean bebas.
 *  - entryTypes: hanya jenis entry ini yang dikirim (20 Okt: entry stop dinonaktifkan, hasil live buruk).
 *  - windows: di jam lokal [startHour, endHour) hanya jenis entry tertentu, maks N sinyal per hari.
 *  - quiet: jam istirahat (mis. 23.10–05.00 WIB) tanpa sinyal baru; setup yang belum kena entry
 *    dikedaluwarsakan, sinyal berjalan tetap dilacak, dan rekap hari dikirim sekali.
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

/** awalan alasan jam istirahat (dipakai UI untuk judul kartu) */
export const QUIET_PREFIX = "Jam istirahat";

/** menit lokal sejak tengah malam */
const localMinute = (sec: number, q: QuietHours) => Math.floor(((sec + q.utcOffsetHours * 3600) % 86400) / 60);
const startMin = (q: QuietHours) => q.startHour * 60 + q.startMinute;
const endMin = (q: QuietHours) => q.endHour * 60 + q.endMinute;
const hhmm = (h: number, m: number) => `${String(h).padStart(2, "0")}.${String(m).padStart(2, "0")}`;

export function inQuiet(sec: number, q: QuietHours): boolean {
  const m = localMinute(sec, q);
  const a = startMin(q);
  const b = endMin(q);
  return a > b ? m >= a || m < b : m >= a && m < b;
}

export function quietReason(q: QuietHours): string {
  return `${QUIET_PREFIX} ${q.label} — sinyal baru berhenti, lanjut ${hhmm(q.endHour, q.endMinute)}.`;
}

export interface DayRecap {
  /** awal hari trading: tengah malam lokal (detik UTC) */
  dayStartSec: number;
  ready: number;
  entries: number;
  wins: number;
  losses: number;
  timeouts: number;
  pips: number;
  running: number;
}

/**
 * Rekap hari trading = dari akhir jam istirahat (mis. 05.00) sampai awal jam istirahat (23.10) hari lokal
 * itu. Bila sekarang sebelum akhir jam istirahat (lewat tengah malam), yang direkap hari sebelumnya.
 * Setup yang dikecualikan pengguna tidak dihitung.
 */
export function dailyRecap(setups: StoredSetup[], nowSec: number, q: QuietHours): DayRecap {
  const off = q.utcOffsetHours * 3600;
  let day = Math.floor((nowSec + off) / 86400);
  if (localMinute(nowSec, q) < endMin(q)) day -= 1;
  const midnight = day * 86400 - off;
  const from = midnight + endMin(q) * 60;
  const to = midnight + startMin(q) * 60;
  const inDay = (t: number | null) => t != null && t >= from && t < to;
  const list = setups.filter((s) => s.eligible && !s.excluded);
  const touched = list.filter((s) => inDay(s.entry_touched_at_sec));
  const closed = touched.filter((s) => s.outcome === "win" || s.outcome === "loss" || s.outcome === "timeout");
  return {
    dayStartSec: midnight,
    ready: list.filter((s) => inDay(s.created_at_sec)).length,
    entries: touched.length,
    wins: closed.filter((s) => s.outcome === "win").length,
    losses: closed.filter((s) => s.outcome === "loss").length,
    timeouts: closed.filter((s) => s.outcome === "timeout").length,
    pips: closed.reduce((a, s) => a + (s.outcome_pips ?? 0), 0),
    running: touched.filter((s) => s.outcome == null || s.outcome === "open").length,
  };
}

export function deliveryBlock(
  c: { entryType: EntryType; stopKind?: StopKind },
  known: StoredSetup[],
  cfg: Pick<EngineConfig, "delivery">,
  nowSec: number,
): string | null {
  const rules = cfg.delivery;
  if (!rules) return null;
  if (rules.quiet && inQuiet(nowSec, rules.quiet)) return quietReason(rules.quiet);
  if (rules.entryTypes && !rules.entryTypes.includes(c.entryType)) return `Entry ${c.entryType} dinonaktifkan (hanya ${rules.entryTypes.join("/")}).`;
  if (c.entryType === "stop" && rules.stopKinds && !rules.stopKinds.includes(c.stopKind ?? "in_zone"))
    return "Entry stop di dalam area tanpa konfirmasi dinonaktifkan (hanya stop saat harga kembali ke area).";
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

/**
 * Reset tampilan harian (Signal History & lonceng) di awal jam istirahat 23.10 WIB. Hanya penyaring
 * tampilan — data tidak dihapus. Disamakan dengan engine_state.config.delivery.quiet (start).
 */
export const DAILY_RESET = { hour: 23, minute: 10, utcOffsetHours: 7 };

/** batas reset (23.10 WIB) terakhir yang ≤ sekarang, detik UTC */
export function lastResetSec(nowSec: number, r = DAILY_RESET): number {
  const off = r.utcOffsetHours * 3600;
  const today = Math.floor((nowSec + off) / 86400) * 86400 - off + (r.hour * 60 + r.minute) * 60;
  return today <= nowSec ? today : today - 86400;
}

export type PerfPeriod = "day" | "week" | "month" | "all";

/** awal periode panel Overall Performance (detik UTC): hari trading berjalan, Senin & tanggal 1 di WIB */
export function periodStart(p: PerfPeriod, nowSec: number, r = DAILY_RESET): number {
  const off = r.utcOffsetHours * 3600;
  if (p === "all") return 0;
  if (p === "day") return lastResetSec(nowSec, r);
  const d = new Date((nowSec + off) * 1000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  if (p === "month") return Date.UTC(y, m, 1) / 1000 - off;
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  return Date.UTC(y, m, d.getUTCDate() - sinceMonday) / 1000 - off;
}
