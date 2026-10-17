import type { Candle } from "./types.ts";
import { addDays, zonedParts, zonedToEpochMs, ymd } from "./time.ts";

// ---------------------------------------------------------------------------
// Jadwal perdagangan (buka/tutup pasar) — BERBEDA dari jam sesi analisis.
// Default mengikuti jadwal umum spot gold/CFD: buka Minggu 18:00 New York,
// tutup Jumat 17:00 New York, jeda harian 17:00–18:00 New York.
// Jika provider mengirim status pasar (mis. Twelve Data `is_market_open`),
// status provider yang dipakai. Hari libur dapat ditambahkan ke `holidays`.
// ---------------------------------------------------------------------------

export interface TradingSchedule {
  tz: string;
  weeklyOpen: { weekday: number; hour: number };
  weeklyClose: { weekday: number; hour: number };
  dailyBreak?: { startHour: number; endHour: number };
  /** tanggal (YYYY-MM-DD, di zona `tz`) pasar tutup penuh */
  holidays: string[];
}

export const DEFAULT_SCHEDULE: TradingSchedule = {
  tz: "America/New_York",
  weeklyOpen: { weekday: 0, hour: 18 },
  weeklyClose: { weekday: 5, hour: 17 },
  dailyBreak: { startHour: 17, endHour: 18 },
  holidays: [],
};

export function isMarketOpenBySchedule(epochMs: number, s: TradingSchedule = DEFAULT_SCHEDULE): boolean {
  const p = zonedParts(epochMs, s.tz);
  if (s.holidays.includes(ymd(epochMs, s.tz))) return false;
  const minuteOfWeek = p.weekday * 1440 + p.hour * 60 + p.minute;
  const open = s.weeklyOpen.weekday * 1440 + s.weeklyOpen.hour * 60;
  const close = s.weeklyClose.weekday * 1440 + s.weeklyClose.hour * 60;
  if (minuteOfWeek < open || minuteOfWeek >= close) return false;
  if (s.dailyBreak) {
    const m = p.hour * 60 + p.minute;
    if (m >= s.dailyBreak.startHour * 60 && m < s.dailyBreak.endHour * 60) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Sesi analisis (Asia, London, New York) dalam zona IANA masing-masing.
// ---------------------------------------------------------------------------

export type SessionId = "asia" | "london" | "newyork";

export interface SessionDef {
  id: SessionId;
  name: string;
  tz: string;
  startHour: number;
  endHour: number;
}

export const SESSIONS: SessionDef[] = [
  { id: "asia", name: "Asia (Tokyo)", tz: "Asia/Tokyo", startHour: 9, endHour: 18 },
  { id: "london", name: "London", tz: "Europe/London", startHour: 8, endHour: 17 },
  { id: "newyork", name: "New York", tz: "America/New_York", startHour: 8, endHour: 17 },
];

export interface SessionWindow {
  session: SessionDef;
  start: number; // epoch ms
  end: number;
}

/** Semua jendela sesi (hari kerja lokal) yang bersinggungan dengan [from, to]. */
export function sessionWindows(from: number, to: number, defs: SessionDef[] = SESSIONS): SessionWindow[] {
  const out: SessionWindow[] = [];
  for (const def of defs) {
    const p = zonedParts(from, def.tz);
    for (let i = -1; i <= Math.ceil((to - from) / 86400000) + 1; i++) {
      const d = addDays(p.year, p.month, p.day, i);
      const weekday = new Date(Date.UTC(d.y, d.m - 1, d.d)).getUTCDay();
      if (weekday === 0 || weekday === 6) continue;
      const start = zonedToEpochMs(d.y, d.m, d.d, def.startHour, 0, def.tz);
      const end = zonedToEpochMs(d.y, d.m, d.d, def.endHour, 0, def.tz);
      if (end >= from && start <= to) out.push({ session: def, start, end });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

export function activeSessions(now: number, defs: SessionDef[] = SESSIONS): SessionWindow[] {
  return sessionWindows(now - 86400000, now + 86400000, defs).filter((w) => w.start <= now && now < w.end);
}

export function nextSessionOpen(now: number, defs: SessionDef[] = SESSIONS): SessionWindow | undefined {
  return sessionWindows(now, now + 4 * 86400000, defs).find((w) => w.start > now);
}

/** Sesi dominan untuk label setup/jurnal (sesi terakhir yang dibuka bila tumpang tindih). */
export function sessionAt(epochMs: number, defs: SessionDef[] = SESSIONS): SessionId | "off" {
  const act = activeSessions(epochMs, defs);
  if (act.length === 0) return "off";
  return act.sort((a, b) => b.start - a.start)[0].session.id;
}

export interface SessionRange {
  session: SessionDef;
  start: number;
  end: number;
  inProgress: boolean;
  high: number;
  low: number;
  rangeUsd: number;
  bars: number;
  /** range sesi dibanding rata-rata range sesi yang sama sebelumnya (dihitung dari data) */
  relativeToAverage: number | null;
  averageRangeUsd: number | null;
  sampleSessions: number;
  volatility: "rendah" | "normal" | "tinggi" | "data kurang";
}

/**
 * Ringkasan range tiap sesi terbaru dari candle intraday (mis. M5/M15).
 * Volatilitas = range sesi terakhir / rata-rata range sesi yang sama pada data.
 */
export function sessionRanges(candles: Candle[], now: number, lookbackDays = 10, defs: SessionDef[] = SESSIONS): SessionRange[] {
  const windows = sessionWindows(now - lookbackDays * 86400000, now, defs).filter((w) => w.start <= now);
  const result: SessionRange[] = [];
  for (const def of defs) {
    const own = windows.filter((w) => w.session.id === def.id);
    const stats = own.map((w) => {
      const bars = candles.filter((c) => c.time * 1000 >= w.start && c.time * 1000 < Math.min(w.end, now));
      const high = bars.length ? Math.max(...bars.map((b) => b.high)) : NaN;
      const low = bars.length ? Math.min(...bars.map((b) => b.low)) : NaN;
      return { w, bars: bars.length, high, low, range: high - low };
    });
    const latest = stats[stats.length - 1];
    if (!latest || latest.bars === 0) continue;
    const prev = stats.slice(0, -1).filter((s) => s.bars > 0 && s.w.end <= now);
    const avg = prev.length ? prev.reduce((a, s) => a + s.range, 0) / prev.length : null;
    const rel = avg && avg > 0 ? latest.range / avg : null;
    result.push({
      session: def,
      start: latest.w.start,
      end: latest.w.end,
      inProgress: now < latest.w.end,
      high: latest.high,
      low: latest.low,
      rangeUsd: latest.range,
      bars: latest.bars,
      relativeToAverage: rel,
      averageRangeUsd: avg,
      sampleSessions: prev.length,
      volatility: rel == null || prev.length < 3 ? "data kurang" : rel < 0.75 ? "rendah" : rel > 1.3 ? "tinggi" : "normal",
    });
  }
  return result;
}
