"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import { AppShell } from "@/components/Shell";
import { Card, Disclaimer, Field } from "@/components/ui";
import { useAuth, DEFAULT_SETTINGS, type UserSettings } from "@/lib/auth";
import { friendlyError, supabase } from "@/lib/supabase";
import { pipsToPrice } from "@/core/instrument";
import { PushToggle } from "@/components/PushToggle";

export default function Page() {
  return (
    <AppShell>
      <SettingsPage />
    </AppShell>
  );
}

const pos = z.number().positive();
const schema = z
  .object({
    display_tz: z.string().min(1).max(64).refine((tz) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, "Zona waktu IANA tidak dikenal"),
    broker_name: z.string().max(80).nullable(),
    pip_size: pos.max(10),
    tick_size: pos.max(10),
    digits: z.number().int().min(0).max(6),
    contract_size: pos.max(100000),
    lot_step: pos.max(100),
    min_lot: pos,
    max_lot: pos,
    commission_per_lot: z.number().min(0),
    account_currency: z.string().regex(/^[A-Z]{3}$/, "Kode mata uang 3 huruf (USD, IDR, …)"),
    quote_to_account_rate: pos,
    account_balance: z.number().min(0),
    starting_balance: pos.nullable(),
    risk_percent: pos.max(100),
    default_spread_pips: z.number().min(0).max(1000),
    sl_pips: pos,
    tp1_pips: pos,
    tp2_pips: pos,
    tp3_pips: pos,
    near_entry_pips: pos.max(1000),
    notify_cooldown_min: z.number().int().min(0).max(1440),
    min_score_m15: z.number().int().min(0).max(100),
    min_score_h1: z.number().int().min(0).max(100),
  })
  .refine((s) => s.min_lot <= s.max_lot, { message: "Lot minimum harus ≤ lot maksimum" });

const KINDS: [string, string][] = [
  ["new_setup", "Setup valid baru"],
  ["near_entry", "Harga mendekati area entry"],
  ["confirmed", "Konfirmasi entry terpenuhi"],
  ["entry_touched", "Entry tersentuh (feed)"],
  ["invalid", "Setup invalid"],
  ["expired", "Setup kedaluwarsa"],
  ["connection", "Gangguan koneksi data"],
];

function SettingsPage() {
  const { settings, reloadSettings, session } = useAuth();
  const [f, setF] = useState<Record<string, string>>({});
  const [kinds, setKinds] = useState<Record<string, boolean>>(DEFAULT_SETTINGS.notify_kinds);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!settings) return;
    const s = settings as unknown as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const k of Object.keys(DEFAULT_SETTINGS)) if (typeof s[k] !== "object" || s[k] === null) out[k] = s[k] == null ? "" : String(s[k]);
    out.min_score_m15 = String(settings.min_score?.M15 ?? 60);
    out.min_score_h1 = String(settings.min_score?.H1 ?? 60);
    setF(out);
    setKinds({ ...DEFAULT_SETTINGS.notify_kinds, ...settings.notify_kinds });
  }, [settings]);

  const n = (k: string) => Number(String(f[k] ?? "").replace(",", "."));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const parsed = schema.safeParse({
      display_tz: f.display_tz,
      broker_name: f.broker_name?.trim() || null,
      pip_size: n("pip_size"),
      tick_size: n("tick_size"),
      digits: n("digits"),
      contract_size: n("contract_size"),
      lot_step: n("lot_step"),
      min_lot: n("min_lot"),
      max_lot: n("max_lot"),
      commission_per_lot: n("commission_per_lot"),
      account_currency: (f.account_currency ?? "").toUpperCase(),
      quote_to_account_rate: n("quote_to_account_rate"),
      account_balance: n("account_balance"),
      starting_balance: f.starting_balance ? n("starting_balance") : null,
      risk_percent: n("risk_percent"),
      default_spread_pips: n("default_spread_pips"),
      sl_pips: n("sl_pips"),
      tp1_pips: n("tp1_pips"),
      tp2_pips: n("tp2_pips"),
      tp3_pips: n("tp3_pips"),
      near_entry_pips: n("near_entry_pips"),
      notify_cooldown_min: n("notify_cooldown_min"),
      min_score_m15: n("min_score_m15"),
      min_score_h1: n("min_score_h1"),
    });
    if (!parsed.success) return setMsg({ ok: false, text: `${parsed.error.issues[0].path.join(".")}: ${parsed.error.issues[0].message}` });
    const { min_score_m15, min_score_h1, ...rest } = parsed.data;
    setBusy(true);
    const { error } = await supabase()
      .from("user_settings")
      .update({ ...rest, min_score: { M15: min_score_m15, H1: min_score_h1 }, notify_kinds: kinds })
      .eq("user_id", session!.user.id);
    setBusy(false);
    if (error) return setMsg({ ok: false, text: friendlyError(error) });
    await reloadSettings();
    setMsg({ ok: true, text: "Pengaturan disimpan." });
  }

  if (!settings) return <p className="text-sm text-muted">Memuat…</p>;
  const inp = (k: string, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <input className="input num" value={f[k] ?? ""} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
    </Field>
  );
  const pipPrice = Number.isFinite(n("pip_size")) ? n("pip_size") : 0.1;
  const spec = { symbol: "", pipSize: pipPrice, tickSize: 0.01, digits: 2, contractSize: 100, quoteCurrency: "USD" };

  return (
    <form className="space-y-4" onSubmit={save}>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-bold">Pengaturan</h1>
        <button className="btn-gold" disabled={busy}>
          {busy ? "Menyimpan…" : "Simpan pengaturan"}
        </button>
      </div>
      {msg && <p className={msg.ok ? "text-sm text-buy" : "text-sm text-sell"} role="alert">{msg.text}</p>}

      <Card title="Pips & level default">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {inp("sl_pips", "SL (pips)", `= ${pipsToPrice(n("sl_pips") || 0, spec)} harga`)}
          {inp("tp1_pips", "TP1 (pips)", `= ${pipsToPrice(n("tp1_pips") || 0, spec)}`)}
          {inp("tp2_pips", "TP2 (pips)", `= ${pipsToPrice(n("tp2_pips") || 0, spec)}`)}
          {inp("tp3_pips", "TP3 (pips)", `= ${pipsToPrice(n("tp3_pips") || 0, spec)}`)}
          {inp("default_spread_pips", "Spread asumsi (pips)")}
        </div>
        <p className="mt-2 text-xs text-muted">
          Default aplikasi: 1 pip = 0,10 USD per troy ounce. Setup engine memakai rencana server (SL 50 / TP 50-100-150 pips); nilai di sini dipakai kalkulator & formulir Anda.
        </p>
      </Card>

      <Card title="Spesifikasi broker">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Nama broker">
            <input className="input" maxLength={80} value={f.broker_name ?? ""} onChange={(e) => setF({ ...f, broker_name: e.target.value })} />
          </Field>
          {inp("pip_size", "Pip size", "Harga per 1 pip")}
          {inp("tick_size", "Tick size")}
          {inp("digits", "Jumlah desimal")}
          {inp("contract_size", "Contract size (oz/lot)")}
          {inp("lot_step", "Lot step")}
          {inp("min_lot", "Lot minimum")}
          {inp("max_lot", "Lot maksimum")}
          {inp("commission_per_lot", "Komisi/lot (round-turn)")}
        </div>
      </Card>

      <Card title="Akun & risiko">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Field label="Mata uang akun">
            <input className="input" maxLength={3} value={f.account_currency ?? ""} onChange={(e) => setF({ ...f, account_currency: e.target.value.toUpperCase() })} />
          </Field>
          {inp("quote_to_account_rate", "Kurs USD → akun", "Isi kurs aktual broker")}
          {inp("account_balance", "Saldo")}
          {inp("starting_balance", "Saldo awal (drawdown %)")}
          {inp("risk_percent", "Risiko per transaksi (%)")}
        </div>
      </Card>

      <Card title="Notifikasi">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {inp("near_entry_pips", "Ambang mendekati entry (pips)")}
          {inp("notify_cooldown_min", "Cooldown peringatan (menit)")}
          {inp("min_score_m15", "Skor minimum M15")}
          {inp("min_score_h1", "Skor minimum H1")}
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {KINDS.map(([k, l]) => (
            <label key={k} className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="accent-[#d6b25e]" checked={kinds[k] !== false} onChange={(e) => setKinds({ ...kinds, [k]: e.target.checked })} />
              {l}
            </label>
          ))}
        </div>
        <div className="mt-4">
          <PushToggle />
        </div>
        <p className="mt-2 text-xs text-muted">Peringatan jarak entry adalah pemicu berbasis jarak harga dan tidak dijamin tiba sebelum harga menyentuh entry.</p>
      </Card>

      <Card title="Tampilan">
        <Field label="Zona waktu tampilan (IANA)" hint="Asia/Jakarta atau UTC disarankan">
          <select className="input sm:w-72" value={f.display_tz ?? "Asia/Jakarta"} onChange={(e) => setF({ ...f, display_tz: e.target.value })}>
            {["Asia/Jakarta", "UTC", "Asia/Makassar", "Asia/Jayapura", "Asia/Singapore", "Europe/London", "America/New_York"].map((z) => (
              <option key={z}>{z}</option>
            ))}
          </select>
        </Field>
      </Card>
      <Disclaimer />
    </form>
  );
}
