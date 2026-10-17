"use client";

import { useEffect, useState } from "react";
import { disablePush, enablePush, getPushState, isIos, requestServerTest, testNotification, type PushState } from "@/lib/push";
import { cx } from "./ui";

const TEXT: Record<PushState, string> = {
  unsupported: "Browser ini tidak mendukung notifikasi push.",
  "ios-needs-install": "iPhone/iPad: tekan Bagikan → “Tambahkan ke Layar Utama”, buka GOLDMARKET dari ikon tersebut, lalu aktifkan notifikasi (iOS 16.4+).",
  denied: "Notifikasi diblokir. Izinkan lewat pengaturan situs browser (ikon gembok di address bar → Notifikasi → Izinkan).",
  default: "Aktifkan untuk menerima setup baru, harga mendekati entry, konfirmasi, hasil sinyal, dan gangguan koneksi — termasuk saat aplikasi ditutup.",
  "granted-off": "Izin sudah diberikan, tetapi perangkat ini belum terdaftar untuk push.",
  on: "Notifikasi push aktif di perangkat ini.",
};

/** Kontrol notifikasi perangkat. variant "banner" hanya tampil bila belum aktif. */
export function PushToggle({ variant = "card" }: { variant?: "card" | "banner" | "compact" }) {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    void getPushState().then(setState);
    try {
      setHidden(localStorage.getItem("gm:push-banner-hidden") === "1");
    } catch {
      /* abaikan */
    }
  }, []);

  if (!state) return null;
  if (variant === "banner" && (state === "on" || state === "unsupported" || hidden)) return null;

  const on = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await enablePush();
      setMsg(r.message);
    } catch (e) {
      setMsg((e as Error).message);
    }
    setState(await getPushState());
    setBusy(false);
  };
  const off = async () => {
    setBusy(true);
    await disablePush();
    setState(await getPushState());
    setBusy(false);
  };

  const canEnable = state === "default" || state === "granted-off";
  return (
    <div className={cx("rounded-2xl border p-4", variant === "banner" ? "border-gold/40 bg-gold/5" : "border-line bg-surface-2/50", variant === "compact" && "p-3")}>
      <div className="flex flex-wrap items-center gap-3">
        <span className={cx("grid h-10 w-10 shrink-0 place-items-center rounded-xl", state === "on" ? "bg-buy/15 text-buy" : "bg-gold/15 text-gold")} aria-hidden>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{state === "on" ? "Notifikasi HP aktif" : "Notifikasi HP & desktop"}</div>
          <p className="text-xs text-muted">{TEXT[state]}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canEnable && (
            <button className="btn-gold" disabled={busy} onClick={on}>
              {busy ? "Meminta izin…" : "Aktifkan notifikasi"}
            </button>
          )}
          {state === "on" && (
            <>
              <button className="btn-ghost text-xs" onClick={() => testNotification().then((ok) => setMsg(ok ? "Notifikasi uji dikirim." : "Gagal menampilkan notifikasi uji."))}>
                Uji lokal
              </button>
              <button className="btn-ghost text-xs" onClick={() => requestServerTest().then((r) => setMsg(r.message))}>
                Uji push dari server
              </button>
              <button className="btn-ghost text-xs" disabled={busy} onClick={off}>
                Matikan di perangkat ini
              </button>
            </>
          )}
          {variant === "banner" && (
            <button
              className="text-xs text-muted hover:text-ink"
              onClick={() => {
                setHidden(true);
                try {
                  localStorage.setItem("gm:push-banner-hidden", "1");
                } catch {
                  /* abaikan */
                }
              }}
            >
              Nanti
            </button>
          )}
        </div>
      </div>
      {msg && <p className="mt-2 text-xs text-gold">{msg}</p>}
      {variant !== "banner" && (
        <p className="mt-2 text-[11px] text-muted">
          {isIos() ? "iOS: push hanya untuk aplikasi yang dipasang di Layar Utama (Safari, iOS 16.4+). " : "Android: Chrome/Edge/Firefox. "}
          Notifikasi tidak dijamin selalu tiba tepat waktu (bergantung jaringan, mode hemat baterai, dan sistem operasi).
        </p>
      )}
    </div>
  );
}
