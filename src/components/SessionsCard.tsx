"use client";

import { useEffect, useMemo, useState } from "react";
import { activeSessions, nextSessionOpen, sessionRanges, SESSIONS } from "@/core/sessions";
import { formatDuration } from "@/core/time";
import type { Candle } from "@/core/types";
import { fetchCandles } from "@/lib/market";
import { Card, cx, fmt, useNow } from "./ui";

export function SessionsCard({ source, defaultTz }: { source: string | null; defaultTz: string }) {
  const now = useNow(1000);
  const [tz, setTz] = useState(defaultTz === "UTC" ? "UTC" : "Asia/Jakarta");
  const [candles, setCandles] = useState<Candle[]>([]);
  useEffect(() => {
    if (!source) return;
    let alive = true;
    const load = () => fetchCandles(source, "M15", 1000).then((c) => alive && setCandles(c)).catch(() => {});
    void load();
    const t = setInterval(load, 5 * 60000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [source]);

  const active = activeSessions(now);
  const next = nextSessionOpen(now);
  const ranges = useMemo(() => sessionRanges(candles, now), [candles, Math.floor(now / 60000)]); // eslint-disable-line react-hooks/exhaustive-deps
  const clock = (ms: number) => new Date(ms).toLocaleTimeString("id-ID", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });

  return (
    <Card
      title="Sesi perdagangan"
      action={
        <div className="flex rounded-lg border border-line p-0.5 text-xs" role="group" aria-label="Zona waktu">
          {["Asia/Jakarta", "UTC"].map((z) => (
            <button key={z} onClick={() => setTz(z)} className={cx("rounded-md px-2 py-1", tz === z ? "bg-gold/15 text-gold" : "text-muted")}>
              {z === "UTC" ? "UTC" : "WIB"}
            </button>
          ))}
        </div>
      }
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">Sekarang ({tz === "UTC" ? "UTC" : "Asia/Jakarta"}):</span>
        <span className="num font-semibold">{clock(now)}</span>
        <span className="text-muted">·</span>
        {active.length ? (
          active.map((w) => (
            <span key={w.session.id} className="chip border-buy/50 text-buy">
              {w.session.name} berlangsung · sisa {formatDuration(w.end - now)}
            </span>
          ))
        ) : (
          <span className="chip border-line text-muted">Tidak ada sesi utama aktif</span>
        )}
      </div>
      {next && (
        <p className="mt-2 text-sm">
          Berikutnya: <strong>{next.session.name}</strong> buka {clock(next.start)} — <span className="num text-gold">{formatDuration(next.start - now)}</span>
        </p>
      )}
      <div className="mt-3 overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Sesi</th>
              <th>Jam ({tz === "UTC" ? "UTC" : "WIB"})</th>
              <th>High</th>
              <th>Low</th>
              <th>Range</th>
              <th>Volatilitas</th>
            </tr>
          </thead>
          <tbody>
            {SESSIONS.map((def) => {
              const r = ranges.find((x) => x.session.id === def.id);
              return (
                <tr key={def.id}>
                  <td>
                    {def.name}
                    {r?.inProgress && <span className="ml-1 text-[10px] text-buy">(berjalan)</span>}
                  </td>
                  <td className="num">{r ? `${clock(r.start)}–${clock(r.end)}` : "—"}</td>
                  <td className="num">{fmt(r?.high)}</td>
                  <td className="num">{fmt(r?.low)}</td>
                  <td className="num">{r ? fmt(r.rangeUsd) : "—"}</td>
                  <td title={r?.averageRangeUsd ? `Rata-rata ${r.sampleSessions} sesi: ${fmt(r.averageRangeUsd)}` : undefined}>
                    {r ? `${r.volatility}${r.relativeToAverage ? ` (${fmt(r.relativeToAverage * 100, 0)}%)` : ""}` : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-muted">
        Jam sesi analisis memakai zona IANA (Asia/Tokyo, Europe/London, America/New_York) sehingga DST otomatis. Status buka/tutup pasar memakai jadwal provider, bukan jam sesi ini. Volatilitas = range sesi terakhir dibanding rata-rata sesi sama (data M15).
      </p>
    </Card>
  );
}
