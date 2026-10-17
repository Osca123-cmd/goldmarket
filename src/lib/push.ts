"use client";

import { supabase } from "./supabase";

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export type PushState =
  | "unsupported" // browser tidak mendukung Web Push
  | "ios-needs-install" // iPhone/iPad: harus "Tambahkan ke Layar Utama" dulu (iOS 16.4+)
  | "denied" // izin ditolak — ubah lewat pengaturan browser
  | "default" // belum pernah ditanya
  | "granted-off" // izin ada, perangkat ini belum berlangganan
  | "on"; // aktif

export function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
}

function supported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export async function registerSw(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register(`${BASE}/sw.js`, { scope: `${BASE}/` });
  } catch {
    return null;
  }
}

export async function getPushState(): Promise<PushState> {
  if (isIos() && !isStandalone()) return "ios-needs-install";
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission === "default") return "default";
  const reg = await navigator.serviceWorker.getRegistration(`${BASE}/`);
  const sub = await reg?.pushManager.getSubscription();
  return sub ? "on" : "granted-off";
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Harus dipanggil dari aksi pengguna (klik) — browser mewajibkan ini untuk meminta izin. */
export async function enablePush(): Promise<{ ok: boolean; message: string }> {
  if (isIos() && !isStandalone()) return { ok: false, message: "Di iPhone/iPad: buka menu Bagikan → “Tambahkan ke Layar Utama”, buka GOLDMARKET dari ikon itu, lalu aktifkan notifikasi (iOS 16.4+)." };
  if (!supported()) return { ok: false, message: "Browser ini tidak mendukung notifikasi push. Gunakan Chrome/Edge/Firefox terbaru atau Safari iOS 16.4+ (sebagai aplikasi layar utama)." };
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return { ok: false, message: perm === "denied" ? "Izin ditolak. Buka pengaturan situs di browser untuk mengizinkan notifikasi." : "Izin belum diberikan." };
  const reg = await registerSw();
  if (!reg) return { ok: false, message: "Service worker gagal didaftarkan." };
  await navigator.serviceWorker.ready;
  const { data: cfg } = await supabase().from("push_config").select("public_key").eq("id", "vapid").maybeSingle();
  if (!cfg?.public_key) return { ok: false, message: "Server push belum siap (kunci VAPID belum dibuat). Coba lagi 1–2 menit lagi." };
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(cfg.public_key) });
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  const { error } = await supabase()
    .from("push_subscriptions")
    .upsert({ endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth, user_agent: navigator.userAgent.slice(0, 300) }, { onConflict: "endpoint", ignoreDuplicates: true });
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Notifikasi aktif di perangkat ini." };
}

export async function disablePush(): Promise<void> {
  const reg = await navigator.serviceWorker?.getRegistration(`${BASE}/`);
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await supabase().from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
    await sub.unsubscribe();
  }
}

/** Notifikasi uji lokal untuk memastikan tampilan notifikasi di perangkat ini berfungsi. */
export async function testNotification(): Promise<boolean> {
  const reg = (await navigator.serviceWorker?.getRegistration(`${BASE}/`)) ?? (await registerSw());
  if (!reg || Notification.permission !== "granted") return false;
  await reg.showNotification("GOLDMARKET — uji notifikasi", { body: "Notifikasi di perangkat ini berfungsi.", icon: `${BASE}/icon-192.png`, badge: `${BASE}/badge-96.png`, tag: "test" });
  return true;
}

/** Minta engine mengirim push uji ke semua perangkat akun ini (diproses pada siklus engine berikutnya, ±1 menit). */
export async function requestServerTest(): Promise<{ ok: boolean; message: string }> {
  const { error } = await supabase().from("user_alerts").insert({ dedupe_key: `pushtest:${Date.now()}` });
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Permintaan terkirim. Push dari server akan tiba dalam ±1 menit (tutup aplikasi untuk mengujinya di latar belakang)." };
}
