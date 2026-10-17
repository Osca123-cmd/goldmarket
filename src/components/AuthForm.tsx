"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { z } from "zod";
import { supabase, friendlyError, isConfigured } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { Logo } from "./Shell";
import { Disclaimer, Field } from "./ui";

type Mode = "login" | "register" | "forgot" | "reset";

const email = z.string().trim().email("Format email tidak valid").max(254);
const password = z.string().min(8, "Password minimal 8 karakter").max(72).regex(/[A-Za-z]/, "Harus berisi huruf").regex(/\d/, "Harus berisi angka");

const TITLES: Record<Mode, string> = {
  login: "Masuk",
  register: "Buat akun",
  forgot: "Lupa password",
  reset: "Atur password baru",
};

export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter();
  const { session } = useAuth();
  const [form, setForm] = useState({ email: "", password: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (session && (mode === "login" || mode === "register")) router.replace("/");
  }, [session, mode, router]);

  const base = typeof window !== "undefined" ? window.location.origin + (process.env.NEXT_PUBLIC_BASE_PATH ?? "") : "";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      if (mode !== "reset") email.parse(form.email);
      if (mode === "register" || mode === "reset") {
        password.parse(form.password);
        if (form.password !== form.confirm) throw new Error("Konfirmasi password tidak sama");
      }
    } catch (err) {
      const m = err instanceof z.ZodError ? err.issues[0].message : (err as Error).message;
      return setMsg({ ok: false, text: m });
    }
    setBusy(true);
    try {
      const sb = supabase();
      if (mode === "login") {
        const { error } = await sb.auth.signInWithPassword({ email: form.email.trim(), password: form.password });
        if (error) throw error;
        router.replace("/");
      } else if (mode === "register") {
        const { data, error } = await sb.auth.signUp({ email: form.email.trim(), password: form.password, options: { emailRedirectTo: base + "/login/" } });
        if (error) throw error;
        setMsg({ ok: true, text: data.session ? "Akun dibuat. Mengalihkan…" : "Akun dibuat. Periksa email untuk konfirmasi, lalu login." });
        if (data.session) router.replace("/");
      } else if (mode === "forgot") {
        const { error } = await sb.auth.resetPasswordForEmail(form.email.trim(), { redirectTo: base + "/reset-password/" });
        if (error) throw error;
        setMsg({ ok: true, text: "Jika email terdaftar, tautan reset telah dikirim." });
      } else {
        const { error } = await sb.auth.updateUser({ password: form.password });
        if (error) throw error;
        setMsg({ ok: true, text: "Password diperbarui. Mengalihkan…" });
        setTimeout(() => router.replace("/"), 1200);
      }
    } catch (err) {
      setMsg({ ok: false, text: friendlyError(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md space-y-4">
        <div className="card-hero">
          <Logo tagline />
          <h1 className="mt-5 text-xl font-bold">{TITLES[mode]}</h1>
          {!isConfigured && <p className="mt-2 text-sm text-sell">Supabase belum dikonfigurasi pada build ini.</p>}
          <form className="mt-4 space-y-3" onSubmit={submit} noValidate>
            {mode !== "reset" && (
              <Field label="Email">
                <input className="input" type="email" autoComplete="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </Field>
            )}
            {mode !== "forgot" && (
              <Field label={mode === "reset" ? "Password baru" : "Password"} hint={mode !== "login" ? "Minimal 8 karakter, berisi huruf dan angka." : undefined}>
                <input className="input" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
              </Field>
            )}
            {(mode === "register" || mode === "reset") && (
              <Field label="Ulangi password">
                <input className="input" type="password" autoComplete="new-password" required value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} />
              </Field>
            )}
            {msg && <p className={msg.ok ? "text-sm text-buy" : "text-sm text-sell"} role="alert">{msg.text}</p>}
            <button className="btn-gold w-full" disabled={busy || !isConfigured}>
              {busy ? "Memproses…" : mode === "login" ? "Masuk" : mode === "register" ? "Daftar" : mode === "forgot" ? "Kirim tautan reset" : "Simpan password"}
            </button>
          </form>
          <div className="mt-4 flex flex-wrap justify-between gap-2 text-sm">
            {mode !== "login" && <Link className="text-gold hover:underline" href="/login/">Sudah punya akun? Masuk</Link>}
            {mode === "login" && <Link className="text-gold hover:underline" href="/register/">Buat akun baru</Link>}
            {mode === "login" && <Link className="text-muted hover:text-ink" href="/forgot-password/">Lupa password?</Link>}
          </div>
        </div>
        <Disclaimer />
      </div>
    </div>
  );
}
