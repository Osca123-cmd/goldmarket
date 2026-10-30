// Analisa AI dari gambar (eksperimen): screenshot XAUUSD dari pengguna + data XAU/USD tersimpan →
// model vision gratis (Gemini, cadangan Groq) → validasi deterministik → ai_analyses.
// Dipanggil dari browser dengan JWT pengguna (verify_jwt). API key model hanya di secrets Edge Function.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.118.0";
import {
  AI_CONTEXT_TFS,
  AI_DAILY_LIMIT,
  AI_TFS,
  DEFAULT_XAUUSD,
  aiExpirySec,
  buildAiContext,
  buildAiPrompt,
  closedAsOf,
  parseAiJson,
  validateAiSetup,
  type AiTf,
  type Candle,
  type Timeframe,
} from "../_shared/core/index.ts";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const iso = (sec: number) => new Date(sec * 1000).toISOString();
const sec = (s: string | null | undefined) => (s ? Math.floor(Date.parse(s) / 1000) : null);
const MODEL_TIMEOUT_MS = 45_000;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

type Db = SupabaseClient;

async function loadCandles(db: Db, source: string, tf: Timeframe, limit: number): Promise<Candle[]> {
  const { data, error } = await db.from("market_candles").select("ts,open,high,low,close").eq("source", source).eq("timeframe", tf).order("ts", { ascending: false }).limit(limit);
  if (error) throw new Error(`candle ${tf}: ${error.message}`);
  return (data ?? []).map((r) => ({ time: sec(r.ts)!, open: r.open, high: r.high, low: r.low, close: r.close })).reverse();
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Pesan error aman untuk disimpan/ditampilkan: tanpa API key. */
function scrub(msg: string): string {
  let m = msg.slice(0, 300);
  for (const k of [env("GEMINI_API_KEY"), env("GROQ_API_KEY")]) if (k) m = m.split(k).join("***");
  return m.replace(/key=[^&\s]+/gi, "key=***");
}

interface Provider {
  id: string;
  model: string;
  call(prompt: string, mime: string, b64: string): Promise<string>;
}

function providers(): Provider[] {
  const out: Provider[] = [];
  const gKey = env("GEMINI_API_KEY");
  if (gKey) {
    const model = env("GEMINI_MODEL", "gemini-2.5-flash");
    out.push({
      id: "gemini",
      model,
      async call(prompt, mime, b64) {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": gKey },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: b64 } }] }], generationConfig: { temperature: 0.2, responseMimeType: "application/json" } }),
          signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
        });
        const body = await r.json().catch(() => null);
        if (!r.ok) throw new Error(`Gemini HTTP ${r.status}: ${body?.error?.message ?? ""}`);
        const text = (body?.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
        if (!text) throw new Error(`Gemini tanpa jawaban (${body?.candidates?.[0]?.finishReason ?? body?.promptFeedback?.blockReason ?? "kosong"})`);
        return text;
      },
    });
  }
  const qKey = env("GROQ_API_KEY");
  if (qKey) {
    const model = env("GROQ_MODEL", "meta-llama/llama-4-scout-17b-16e-instruct");
    out.push({
      id: "groq",
      model,
      async call(prompt, mime, b64) {
        if (b64.length > 4_000_000) throw new Error("Groq: gambar terlalu besar untuk base64 (maks. ±3 MB).");
        const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${qKey}` },
          body: JSON.stringify({ model, temperature: 0.2, response_format: { type: "json_object" }, messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } }] }] }),
          signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
        });
        const body = await r.json().catch(() => null);
        if (!r.ok) throw new Error(`Groq HTTP ${r.status}: ${body?.error?.message ?? ""}`);
        const text = body?.choices?.[0]?.message?.content ?? "";
        if (!text) throw new Error("Groq tanpa jawaban");
        return text;
      },
    });
  }
  return out;
}

/** Awal hari WIB (UTC+7) untuk kuota harian. */
function wibDayStartSec(nowSec: number): number {
  const off = 7 * 3600;
  return Math.floor((nowSec + off) / 86400) * 86400 - off;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Metode tidak didukung." }, 405);
  const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: auth } = await db.auth.getUser(jwt);
  const user = auth?.user;
  if (!user) return json({ error: "Silakan login ulang." }, 401);

  const body = await req.json().catch(() => null);
  const tf = AI_TFS.includes(body?.tf) ? (body.tf as AiTf) : null;
  const imagePath = typeof body?.image_path === "string" ? body.image_path : "";
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 300) : "";
  if (!tf) return json({ error: "Pilih timeframe gambar." }, 400);
  if (!imagePath.startsWith(`${user.id}/`) || imagePath.includes("..") || imagePath.length > 300) return json({ error: "Gambar tidak valid." }, 400);

  const list = providers();
  if (!list.length) return json({ error: "API key AI belum diisi (GEMINI_API_KEY / GROQ_API_KEY di secrets Edge Function)." }, 503);

  const now = Math.floor(Date.now() / 1000);
  const { count } = await db.from("ai_analyses").select("id", { count: "exact", head: true }).eq("user_id", user.id).neq("status", "failed").gte("created_at", iso(wibDayStartSec(now)));
  if ((count ?? 0) >= AI_DAILY_LIMIT) return json({ error: `Batas ${AI_DAILY_LIMIT} analisa per hari tercapai (menjaga kuota AI gratis). Coba lagi besok.` }, 429);

  // ---- data angka: harga live + candle tersimpan (sumber yang sama dengan engine) ----
  const { data: snap } = await db.from("market_snapshot").select("source,price,quote_time,market_open").eq("id", "current").maybeSingle();
  if (!snap?.price || !snap.source) return json({ error: "Harga live belum tersedia." }, 503);
  const tfs = [...new Set<Timeframe>([...AI_CONTEXT_TFS[tf], "M15"])];
  const candles: Partial<Record<Timeframe, Candle[]>> = {};
  for (const t of tfs) candles[t] = closedAsOf(await loadCandles(db, snap.source, t, 300), t, now);
  const ctx = buildAiContext({ tf, price: snap.price, priceTimeSec: sec(snap.quote_time) ?? now, candles });
  if (!ctx) return json({ error: `Data candle ${tf} belum cukup untuk analisa.` }, 503);

  // ---- gambar ----
  const { data: blob, error: dlErr } = await db.storage.from("chart-uploads").download(imagePath);
  if (dlErr || !blob) return json({ error: "Gambar gagal dibaca dari penyimpanan." }, 400);
  const mime = blob.type && /^image\/(png|jpeg|webp)$/.test(blob.type) ? blob.type : "image/png";
  const b64 = toBase64(new Uint8Array(await blob.arrayBuffer()));

  // ---- model: Gemini lalu Groq bila gagal/kuota habis ----
  const prompt = buildAiPrompt(ctx, note);
  const errors: string[] = [];
  let used: Provider | null = null;
  let text = "";
  for (const p of list) {
    try {
      text = await p.call(prompt, mime, b64);
      used = p;
      break;
    } catch (e) {
      errors.push(scrub(`${p.id}: ${(e as Error).message}`));
    }
  }
  const base = { user_id: user.id, image_path: imagePath, tf, note, price: ctx.price, provider: used?.id ?? null, model: used?.model ?? null };
  if (!used) {
    const { data } = await db.from("ai_analyses").insert({ ...base, status: "failed", reject_reason: `Model AI gagal: ${errors.join(" | ")}`.slice(0, 400) }).select().single();
    return json({ analysis: data, error: "Model AI gagal dihubungi (kuota gratis habis atau gangguan). Coba lagi nanti." }, 502);
  }

  const raw = parseAiJson(text);
  if (!raw) {
    const { data } = await db.from("ai_analyses").insert({ ...base, status: "failed", raw: { text: text.slice(0, 4000) }, reject_reason: "Jawaban AI bukan JSON yang bisa dibaca." }).select().single();
    return json({ analysis: data, error: "Jawaban AI tidak bisa dibaca. Coba lagi." }, 502);
  }
  const v = validateAiSetup(raw, ctx, DEFAULT_XAUUSD);
  const common = { ...base, raw, bias: raw.bias?.slice(0, 20) ?? null, summary: raw.summary?.slice(0, 600) ?? null, structure: raw.structure ?? [], notes: [...(errors.length ? [`Cadangan dipakai: ${errors.join(" | ")}`] : []), ...v.notes] };
  let row: Record<string, unknown>;
  if (!v.ok) {
    row = { ...common, status: v.status, reject_reason: v.reason };
  } else {
    const s = v.setup;
    const market = s.entryType === "market";
    row = {
      ...common,
      status: market ? "entry_touched" : "pending",
      direction: s.direction,
      entry_type: s.entryType,
      entry: s.entry,
      sl: s.sl,
      tp: s.tp,
      rr: s.rr,
      sl_pips: s.slPips,
      tp_pips: s.tpPips,
      target_reason: s.targetReason?.slice(0, 600) ?? null,
      invalidation: s.invalidation?.slice(0, 400) ?? null,
      reasons: s.reasons,
      expires_at: market ? null : iso(aiExpirySec(tf, now)),
      entry_touched_at: market ? iso(now) : null,
      outcome: market ? "open" : null,
    };
  }
  const { data: saved, error: insErr } = await db.from("ai_analyses").insert(row).select().single();
  if (insErr) return json({ error: `Gagal menyimpan analisa: ${insErr.message}` }, 500);

  if (v.ok) {
    const s = v.setup;
    await db.from("notifications").upsert(
      {
        kind: "new_setup",
        dedupe_key: `ai:${saved.id}`,
        title: `🤖 AI GAMBAR: ${s.direction} XAUUSD ${tf} · RR 1:${s.rr}`,
        body: `${s.entryType === "market" ? "Entry market" : "Limit"} ${s.entry.toFixed(2)}, SL ${s.sl.toFixed(2)} (${s.slPips} pips), TP ${s.tp.toFixed(2)} (${s.tpPips} pips). Eksperimen, belum teruji; bukan saran investasi.`,
        severity: "info",
        timeframe: tf,
      },
      { onConflict: "dedupe_key", ignoreDuplicates: true },
    );
  }
  return json({ analysis: saved });
});
