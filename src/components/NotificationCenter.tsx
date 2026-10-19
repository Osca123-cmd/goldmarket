"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/lib/supabase";
import { useMarket } from "./MarketContext";
import { cx, fmtTime } from "./ui";
import { priceToPips } from "@/core/instrument";
import { PushToggle } from "./PushToggle";
import { readyTitle } from "@/core/engine";

interface Toast {
  key: string;
  title: string;
  body: string;
  severity: "info" | "success" | "warning" | "danger";
}

const SEV: Record<Toast["severity"], string> = {
  info: "border-info/50",
  success: "border-buy/50",
  warning: "border-warn/50",
  danger: "border-sell/50",
};

function readLocal(key: string): number {
  try {
    return Number(localStorage.getItem(key) ?? 0);
  } catch {
    return 0;
  }
}
function writeLocal(key: string, v: number) {
  try {
    localStorage.setItem(key, String(v));
  } catch {
    /* penyimpanan browser tidak tersedia */
  }
}

/**
 * Notifikasi dalam aplikasi:
 *  - Event engine (setup baru, konfirmasi, invalid/kedaluwarsa, gangguan koneksi) dari tabel notifications (realtime).
 *  - "Harga mendekati entry" dihitung di browser dengan ambang per pengguna (default 20 pips),
 *    dedupe per setup (tabel user_alerts) + cooldown. Ini pemicu berbasis jarak, bukan jaminan
 *    peringatan tiba sebelum harga menyentuh entry.
 */
export function NotificationCenter() {
  const { settings, session } = useAuth();
  const { notifications, setups, snapshot } = useMarket();
  const [open, setOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [readIds, setReadIds] = useState<Set<string>>(new Set());
  const seen = useRef<Set<string> | null>(null);
  const nearDone = useRef<Set<string>>(new Set());

  const push = (t: Toast) => {
    setToasts((x) => [...x.filter((y) => y.key !== t.key), t].slice(-4));
    setTimeout(() => setToasts((x) => x.filter((y) => y.key !== t.key)), 9000);
  };

  // status baca dari server
  useEffect(() => {
    if (!session) return;
    supabase()
      .from("notification_reads")
      .select("notification_id")
      .then(({ data }) => setReadIds(new Set((data ?? []).map((r) => r.notification_id))));
    supabase()
      .from("user_alerts")
      .select("dedupe_key")
      .then(({ data }) => (data ?? []).forEach((r) => nearDone.current.add(r.dedupe_key)));
  }, [session]);

  // READY dikirim untuk setiap setup yang dilacak engine (skor tertulis di isi notif), agar urutan
  // READY → entry tersentuh → TP/BE → hasil selalu lengkap; skor minimum hanya menyaring daftar peluang
  const allowed = useMemo(() => {
    const kinds = settings?.notify_kinds ?? {};
    return (n: { kind: string }) => kinds[n.kind] !== false;
  }, [settings]);

  // toast untuk notifikasi engine baru
  useEffect(() => {
    if (!settings) return;
    if (seen.current === null) {
      seen.current = new Set(notifications.map((n) => n.id));
      return;
    }
    for (const n of notifications) {
      if (seen.current.has(n.id)) continue;
      seen.current.add(n.id);
      if (allowed(n)) push({ key: n.id, title: n.title, body: n.body, severity: n.severity });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notifications, settings]);

  // pemicu jarak ke entry (per pengguna)
  useEffect(() => {
    if (!settings || !snapshot?.price || settings.notify_kinds?.near_entry === false) return;
    const cooldownKey = "gm:near:last";
    for (const s of setups) {
      if (!s.eligible || s.status !== "approaching") continue;
      const dist = priceToPips(Math.abs(snapshot.price - s.entry_price), { symbol: "", pipSize: settings.pip_size, tickSize: settings.tick_size, digits: settings.digits, contractSize: settings.contract_size, quoteCurrency: "USD" });
      if (dist > settings.near_entry_pips) continue;
      const key = `near:${s.id}`;
      if (nearDone.current.has(key)) continue;
      if (Date.now() - readLocal(cooldownKey) < settings.notify_cooldown_min * 60000) continue;
      nearDone.current.add(key);
      writeLocal(cooldownKey, Date.now());
      void supabase().from("user_alerts").insert({ dedupe_key: key });
      push({
        key,
        title: readyTitle(s.direction, s.timeframe, ` · ${dist.toFixed(1)} pips lagi`, s.strategy),
        body: `Harga mendekati zona ${s.entry_low.toFixed(2)}–${s.entry_high.toFixed(2)} (entry ${s.entry_price.toFixed(2)}, SL ${s.sl.toFixed(2)}, TP1 ${s.tp1.toFixed(2)}). Ambang ${settings.near_entry_pips} pips.`,
        severity: "warning",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setups, snapshot?.price, settings]);

  const visible = notifications.filter(allowed);
  const unread = visible.filter((n) => !readIds.has(n.id)).length;

  const markAllRead = async () => {
    const ids = visible.filter((n) => !readIds.has(n.id)).map((n) => n.id);
    if (!ids.length) return;
    setReadIds(new Set([...readIds, ...ids]));
    await supabase().from("notification_reads").upsert(ids.map((id) => ({ notification_id: id })), { onConflict: "user_id,notification_id", ignoreDuplicates: true });
  };

  return (
    <>
      <div className="relative">
        <button className="btn-ghost relative px-3" aria-label={`Notifikasi (${unread} belum dibaca)`} onClick={() => setOpen((o) => !o)}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" />
          </svg>
          {unread > 0 && <span className="num absolute -right-1 -top-1 rounded-full bg-gold px-1.5 text-[10px] font-bold text-bg">{unread > 99 ? "99+" : unread}</span>}
        </button>
        {open && (
          <div className="absolute right-0 z-40 mt-2 max-h-[70vh] w-[min(92vw,380px)] overflow-y-auto rounded-2xl border border-line/80 bg-surface p-3 shadow-2xl">
            <div className="mb-2 flex items-center justify-between">
              <span className="card-title">Notifikasi</span>
              <button className="text-xs text-gold hover:underline" onClick={markAllRead}>
                Tandai semua dibaca
              </button>
            </div>
            <div className="mb-2">
              <PushToggle variant="compact" />
            </div>
            {visible.length === 0 && <p className="py-6 text-center text-sm text-muted">Belum ada notifikasi.</p>}
            <ul className="space-y-2">
              {visible.map((n) => (
                <li key={n.id} className={cx("rounded-xl border-l-2 bg-surface-2/60 p-2.5", SEV[n.severity], !readIds.has(n.id) && "ring-1 ring-gold/30")}>
                  <div className="text-sm font-semibold">{n.title}</div>
                  <div className="text-xs text-muted">{n.body}</div>
                  <div className="mt-1 text-[11px] text-muted/80">{fmtTime(n.created_at, settings?.display_tz ?? "Asia/Jakarta", true)}</div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="pointer-events-none fixed inset-x-3 bottom-20 z-50 flex flex-col items-end gap-2 lg:bottom-4" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.key} className={cx("pointer-events-auto w-full max-w-sm rounded-2xl border border-l-4 bg-surface p-3 shadow-2xl", SEV[t.severity])}>
            <div className="text-sm font-semibold">{t.title}</div>
            <div className="text-xs text-muted">{t.body}</div>
          </div>
        ))}
      </div>
    </>
  );
}
