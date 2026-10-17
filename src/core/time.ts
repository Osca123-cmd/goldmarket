// Utilitas zona waktu berbasis IANA (Intl), sehingga daylight saving time
// (London, New York) dihitung otomatis tanpa offset hardcode.

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0=Minggu .. 6=Sabtu
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function zonedParts(epochMs: number, tz: string): ZonedParts {
  const parts = formatter(tz).formatToParts(new Date(epochMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: WEEKDAYS[get("weekday")] ?? 0,
  };
}

/** Offset zona (ms) pada instant tertentu: local - UTC. */
export function tzOffsetMs(epochMs: number, tz: string): number {
  const p = zonedParts(epochMs, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/** Konversi waktu dinding lokal di `tz` menjadi epoch ms (UTC). */
export function zonedToEpochMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let ts = guess - tzOffsetMs(guess, tz);
  // iterasi kedua menangani kasus di sekitar transisi DST
  ts = guess - tzOffsetMs(ts, tz);
  return ts;
}

/** Tambah hari pada tanggal kalender (tanpa memperhatikan zona). */
export function addDays(y: number, m: number, d: number, n: number): { y: number; m: number; d: number } {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export function ymd(epochMs: number, tz: string): string {
  const p = zonedParts(epochMs, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function formatClock(epochMs: number, tz: string): string {
  const p = zonedParts(epochMs, tz);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  const neg = ms < 0;
  let s = Math.floor(Math.abs(ms) / 1000);
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const parts = d > 0 ? [`${d}h`, `${h}j`, `${m}m`] : h > 0 ? [`${h}j`, `${m}m`] : [`${m}m`, `${s}d`];
  return (neg ? "-" : "") + parts.join(" ");
}
