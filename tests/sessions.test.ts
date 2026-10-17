import { describe, expect, it } from "vitest";
import { activeSessions, isMarketOpenBySchedule, nextSessionOpen, sessionWindows } from "../src/core/sessions.ts";
import { zonedToEpochMs } from "../src/core/time.ts";

const utc = (s: string) => Date.parse(s);
const startUtc = (day: string, id: string) =>
  new Date(sessionWindows(utc(day + "T00:00:00Z"), utc(day + "T23:59:00Z")).find((w) => w.session.id === id && new Date(w.start).toISOString().startsWith(day))!.start).toISOString();

describe("sesi & daylight saving time", () => {
  it("London 08:00 lokal = 07:00 UTC saat BST (Juli) dan 08:00 UTC saat GMT (Januari)", () => {
    expect(startUtc("2026-07-15", "london")).toBe("2026-07-15T07:00:00.000Z");
    expect(startUtc("2026-01-14", "london")).toBe("2026-01-14T08:00:00.000Z");
  });

  it("New York 08:00 lokal = 12:00 UTC (EDT) dan 13:00 UTC (EST)", () => {
    expect(startUtc("2026-07-15", "newyork")).toBe("2026-07-15T12:00:00.000Z");
    expect(startUtc("2026-01-14", "newyork")).toBe("2026-01-14T13:00:00.000Z");
  });

  it("transisi DST AS 8 Maret 2026 & UK 29 Maret 2026", () => {
    expect(startUtc("2026-03-06", "newyork")).toBe("2026-03-06T13:00:00.000Z");
    expect(startUtc("2026-03-09", "newyork")).toBe("2026-03-09T12:00:00.000Z");
    expect(startUtc("2026-03-27", "london")).toBe("2026-03-27T08:00:00.000Z");
    expect(startUtc("2026-03-30", "london")).toBe("2026-03-30T07:00:00.000Z");
  });

  it("Asia (Tokyo, tanpa DST) 09:00 JST = 00:00 UTC", () => {
    expect(startUtc("2026-07-15", "asia")).toBe("2026-07-15T00:00:00.000Z");
  });

  it("overlap London–New York terdeteksi; countdown ke sesi berikutnya", () => {
    const t = utc("2026-07-15T13:30:00Z");
    expect(activeSessions(t).map((w) => w.session.id).sort()).toEqual(["london", "newyork"]);
    const next = nextSessionOpen(utc("2026-07-15T22:00:00Z"))!;
    expect(next.session.id).toBe("asia");
    expect(new Date(next.start).toISOString()).toBe("2026-07-16T00:00:00.000Z");
  });

  it("jadwal pasar: tutup akhir pekan & jeda harian, mengikuti DST New York", () => {
    expect(isMarketOpenBySchedule(utc("2026-07-18T12:00:00Z"))).toBe(false); // Sabtu
    expect(isMarketOpenBySchedule(utc("2026-07-15T21:30:00Z"))).toBe(false); // 17:30 EDT jeda
    expect(isMarketOpenBySchedule(utc("2026-01-14T21:30:00Z"))).toBe(true); // 16:30 EST buka
    expect(isMarketOpenBySchedule(utc("2026-07-19T22:30:00Z"))).toBe(true); // Minggu 18:30 EDT buka
  });

  it("zonedToEpochMs konsisten", () => {
    expect(new Date(zonedToEpochMs(2026, 10, 17, 7, 0, "Asia/Jakarta")).toISOString()).toBe("2026-10-17T00:00:00.000Z");
  });
});
