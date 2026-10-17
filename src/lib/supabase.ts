import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Hanya URL + anon/publishable key yang ada di browser. Akses data dibatasi RLS.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

export const isConfigured = Boolean(url && anon);

let client: SupabaseClient | null = null;
export function supabase(): SupabaseClient {
  if (!client) {
    client = createClient(url || "http://localhost", anon || "missing", {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      realtime: { params: { eventsPerSecond: 5 } },
    });
  }
  return client;
}

/** Pesan error yang aman ditampilkan (tanpa detail internal). */
export function friendlyError(e: unknown): string {
  const msg = (e as { message?: string })?.message ?? String(e);
  if (/rate_limited/.test(msg)) return "Terlalu banyak permintaan. Coba lagi sebentar lagi.";
  if (/Invalid login credentials/i.test(msg)) return "Email atau password salah.";
  if (/Email not confirmed/i.test(msg)) return "Email belum dikonfirmasi. Periksa kotak masuk Anda.";
  if (/violates check constraint/i.test(msg)) return "Data tidak valid menurut aturan server.";
  if (/JWT|session/i.test(msg)) return "Sesi berakhir. Silakan login ulang.";
  return msg.length > 200 ? msg.slice(0, 200) + "…" : msg;
}
