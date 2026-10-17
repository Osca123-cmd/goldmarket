"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";

export interface UserSettings {
  user_id: string;
  display_tz: string;
  broker_name: string | null;
  pip_size: number;
  tick_size: number;
  digits: number;
  contract_size: number;
  lot_step: number;
  min_lot: number;
  max_lot: number;
  commission_per_lot: number;
  account_currency: string;
  quote_to_account_rate: number;
  account_balance: number;
  risk_percent: number;
  default_spread_pips: number;
  sl_pips: number;
  tp1_pips: number;
  tp2_pips: number;
  tp3_pips: number;
  near_entry_pips: number;
  news_alert_minutes: number;
  notify_cooldown_min: number;
  min_score: Record<string, number>;
  notify_kinds: Record<string, boolean>;
  browser_push: boolean;
  starting_balance: number | null;
}

export const DEFAULT_SETTINGS: Omit<UserSettings, "user_id"> = {
  display_tz: "Asia/Jakarta",
  broker_name: null,
  pip_size: 0.1,
  tick_size: 0.01,
  digits: 2,
  contract_size: 100,
  lot_step: 0.01,
  min_lot: 0.01,
  max_lot: 100,
  commission_per_lot: 0,
  account_currency: "USD",
  quote_to_account_rate: 1,
  account_balance: 1000,
  risk_percent: 1,
  default_spread_pips: 3,
  sl_pips: 50,
  tp1_pips: 50,
  tp2_pips: 100,
  tp3_pips: 150,
  near_entry_pips: 20,
  news_alert_minutes: 30,
  notify_cooldown_min: 15,
  min_score: { M15: 60, H1: 60 },
  notify_kinds: { new_setup: true, near_entry: true, confirmed: true, invalid: true, expired: true, connection: true, entry_touched: true, signal_result: true, news_event: true },
  browser_push: false,
  starting_balance: null,
};

const NUMERIC_KEYS: (keyof UserSettings)[] = [
  "pip_size", "tick_size", "digits", "contract_size", "lot_step", "min_lot", "max_lot", "commission_per_lot",
  "quote_to_account_rate", "account_balance", "risk_percent", "default_spread_pips", "sl_pips", "tp1_pips",
  "tp2_pips", "tp3_pips", "near_entry_pips", "news_alert_minutes", "notify_cooldown_min",
];

function normalize(row: Record<string, unknown>): UserSettings {
  const out = { ...DEFAULT_SETTINGS, ...row } as Record<string, unknown>;
  for (const k of NUMERIC_KEYS) out[k] = Number(out[k]);
  if (out.starting_balance != null) out.starting_balance = Number(out.starting_balance);
  return out as unknown as UserSettings;
}

interface AuthCtx {
  session: Session | null;
  loading: boolean;
  settings: UserSettings | null;
  reloadSettings: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthCtx>({ session: null, loading: true, settings: null, reloadSettings: async () => {}, signOut: async () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<UserSettings | null>(null);

  const reloadSettings = useCallback(async () => {
    const { data: s } = await supabase().auth.getSession();
    const uid = s.session?.user.id;
    if (!uid) return setSettings(null);
    const { data } = await supabase().from("user_settings").select("*").eq("user_id", uid).maybeSingle();
    if (data) setSettings(normalize(data));
    else {
      // baris pengaturan dibuat trigger saat registrasi; buat jika belum ada (akun lama)
      const { data: created } = await supabase().from("user_settings").insert({ user_id: uid }).select("*").single();
      setSettings(created ? normalize(created) : { ...DEFAULT_SETTINGS, user_id: uid });
    }
  }, []);

  useEffect(() => {
    const sb = supabase();
    sb.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = sb.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (session) void reloadSettings();
    else setSettings(null);
  }, [session, reloadSettings]);

  const signOut = useCallback(async () => {
    await supabase().auth.signOut();
  }, []);

  return <Ctx.Provider value={{ session, loading, settings, reloadSettings, signOut }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
