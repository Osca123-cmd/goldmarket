/**
 * Analisa AI dari gambar (eksperimen, 30 Okt 2026) — pengguna mengunggah screenshot XAUUSD, model vision
 * membaca struktur dari gambar, lalu angka entry/SL/TP dicek & dikunci ke data XAU/USD Twelve Data yang
 * sama dengan engine. Satu TP saja (RR 1:5–1:6, boleh 1:4–1:8 bila TP di level struktur nyata).
 *
 * Modul ini murni (tanpa I/O): konteks numerik, prompt, parser jawaban, validasi deterministik,
 * status order tertunda, dan hasil. Pemanggilan model ada di supabase/functions/chart-ai.
 */
import type { Candle, Direction, Timeframe } from "./types.ts";
import { TF_SECONDS } from "./types.ts";
import { analyzeTimeframe } from "./analysis.ts";
import { evaluateOutcome } from "./outcome.ts";
import { priceToPips, roundTo, type InstrumentSpec } from "./instrument.ts";

export const AI_TFS = ["M5", "M15", "M30", "H1", "H4"] as const;
export type AiTf = (typeof AI_TFS)[number];

/** TF gambar + TF pembanding yang dikirim sebagai data angka */
export const AI_CONTEXT_TFS: Record<AiTf, Timeframe[]> = { M5: ["M5", "M15"], M15: ["M15", "H1"], M30: ["M30", "H1"], H1: ["H1", "H4"], H4: ["H4", "H1"] };

export const AI_RR = { target: [5, 6] as const, min: 4, max: 8 };
export const AI_SL_ATR = { min: 0.5, max: 3 };
/** order limit boleh berjarak maksimal sekian ATR TF gambar dari harga sekarang */
export const AI_ENTRY_MAX_ATR = 1.5;
/** TP dianggap "di level struktur" bila berjarak ≤ sekian ATR dari level S/R (≥2 sentuhan) atau high/low rentang */
export const AI_LEVEL_TOL_ATR = 0.3;
export const AI_EXPIRY_BARS = 12;
export const AI_MAX_HOLD_SEC = 3 * 86400;
export const AI_DAILY_LIMIT = 15;

export interface AiLevel {
  price: number;
  touches: number;
  kind: "support" | "resistance";
  tf: Timeframe;
}

export interface AiContext {
  tf: AiTf;
  price: number;
  priceTimeSec: number;
  /** ATR(14) per TF konteks */
  atr: Partial<Record<Timeframe, number>>;
  /** ATR untuk batas SL: M15 bila ada, selain itu TF gambar */
  atrRisk: number;
  levels: AiLevel[];
  rangeHigh: number;
  rangeLow: number;
  bias: Partial<Record<Timeframe, string>>;
  structure: Partial<Record<Timeframe, string>>;
  /** bar terakhir per TF dalam teks ringkas (UTC) */
  bars: Partial<Record<Timeframe, string>>;
}

const BARS_SENT: Record<"main" | "other", number> = { main: 60, other: 40 };
const fmt = (n: number) => n.toFixed(2);
const hhmm = (sec: number) => new Date(sec * 1000).toISOString().slice(5, 16).replace("T", " ");

/** Konteks numerik dari candle tertutup (`candles` per TF, termasuk M15 untuk ATR risiko bila ada). */
export function buildAiContext(i: { tf: AiTf; price: number; priceTimeSec: number; candles: Partial<Record<Timeframe, Candle[]>> }): AiContext | null {
  const tfs = AI_CONTEXT_TFS[i.tf];
  const main = analyzeTimeframe(i.tf, i.candles[i.tf] ?? []);
  if (!main) return null;
  const atr: Partial<Record<Timeframe, number>> = {};
  const bias: Partial<Record<Timeframe, string>> = {};
  const structure: Partial<Record<Timeframe, string>> = {};
  const bars: Partial<Record<Timeframe, string>> = {};
  const levels: AiLevel[] = [];
  for (const tf of tfs) {
    const list = i.candles[tf] ?? [];
    const a = tf === i.tf ? main : analyzeTimeframe(tf, list);
    if (!a) continue;
    atr[tf] = roundTo(a.atr, 2);
    bias[tf] = a.bias;
    structure[tf] = a.structure.label;
    for (const l of a.levels) {
      if (l.touches >= 2 && Math.abs(l.price - i.price) <= 8 * main.atr) levels.push({ price: roundTo(l.price, 2), touches: l.touches, kind: l.kind, tf });
    }
    const n = tf === i.tf ? BARS_SENT.main : BARS_SENT.other;
    bars[tf] = list
      .slice(-n)
      .map((c) => `${hhmm(c.time)} ${fmt(c.open)} ${fmt(c.high)} ${fmt(c.low)} ${fmt(c.close)}`)
      .join("\n");
  }
  const m15 = i.candles.M15 && i.tf !== "M15" ? analyzeTimeframe("M15", i.candles.M15) : null;
  const recent = (i.candles[i.tf] ?? []).slice(-120);
  return {
    tf: i.tf,
    price: roundTo(i.price, 2),
    priceTimeSec: i.priceTimeSec,
    atr,
    atrRisk: roundTo(i.tf === "M15" ? main.atr : m15?.atr ?? main.atr, 2),
    levels: levels.sort((a, b) => b.price - a.price),
    rangeHigh: Math.max(...recent.map((c) => c.high)),
    rangeLow: Math.min(...recent.map((c) => c.low)),
    bias,
    structure,
    bars,
  };
}

/** Prompt untuk model vision: gambar = struktur, data angka = level presisi. Jawaban wajib JSON. */
export function buildAiPrompt(ctx: AiContext, note = ""): string {
  const lv = ctx.levels.map((l) => `${fmt(l.price)} ${l.kind} ${l.tf} (${l.touches}x)`).join("; ") || "-";
  const tfInfo = Object.keys(ctx.bars)
    .map((tf) => `${tf}: bias ${ctx.bias[tf as Timeframe]}, struktur ${ctx.structure[tf as Timeframe]}, ATR14 ${ctx.atr[tf as Timeframe]}`)
    .join("\n");
  const data = Object.entries(ctx.bars)
    .map(([tf, s]) => `### ${tf} (waktu UTC, open high low close)\n${s}`)
    .join("\n\n");
  return `Kamu analis teknikal XAUUSD (emas spot). Gambar terlampir adalah screenshot chart XAUUSD timeframe ${ctx.tf} dari pengguna.
Tugas: baca struktur pasar dari GAMBAR (tren, swing high/low, BOS/CHoCH, zona supply/demand, support/resistance, pola), lalu cari SATU setup dengan SATU take profit.

Aturan:
- Angka entry, SL, dan TP WAJIB diambil dari DATA ANGKA di bawah (feed XAU/USD), bukan dari skala harga gambar (harga broker bisa berbeda ±1 USD).
- Harga sekarang ${fmt(ctx.price)}. entry_type "market" = masuk di harga sekarang; "limit" = menunggu harga kembali ke entry (maksimal ${AI_ENTRY_MAX_ATR}× ATR ${ctx.tf} = ${fmt(AI_ENTRY_MAX_ATR * (ctx.atr[ctx.tf] ?? 0))} USD dari harga sekarang).
- SL di balik titik invalidasi struktur; jarak SL ${AI_SL_ATR.min}–${AI_SL_ATR.max}× ATR risiko (${fmt(ctx.atrRisk)} USD) = ${fmt(AI_SL_ATR.min * ctx.atrRisk)}–${fmt(AI_SL_ATR.max * ctx.atrRisk)} USD.
- Risk:reward target 1:${AI_RR.target[0]} sampai 1:${AI_RR.target[1]}. Boleh 1:${AI_RR.min}–1:${AI_RR.max} hanya bila TP tepat di level struktur nyata (sebutkan levelnya di target_reason). Tidak ada TP2/TP3.
- Bila struktur tidak jelas, harga di tengah range, atau RR tersebut tidak masuk akal → "setup": null. Jangan memaksakan setup.
- Bila gambar bukan chart harga, tulis image_check.is_chart false.
- Semua teks penjelasan dalam bahasa Indonesia, singkat.

Konteks dari data (bukan dari gambar):
${tfInfo}
Range ${ctx.tf} 120 bar terakhir: high ${fmt(ctx.rangeHigh)}, low ${fmt(ctx.rangeLow)}
Level S/R (≥2 sentuhan): ${lv}
${note.trim() ? `Catatan pengguna: ${note.trim().slice(0, 300)}\n` : ""}
${data}

Jawab HANYA JSON valid dengan bentuk:
{"image_check":{"is_chart":true,"symbol":"XAUUSD","timeframe":"${ctx.tf}"},"bias":"bullish|bearish|ranging","structure":["poin struktur dari gambar"],"summary":"ringkasan 1-2 kalimat","setup":{"direction":"BUY|SELL","entry_type":"market|limit","entry":0,"sl":0,"tp":0,"target_reason":"level/alasan TP","invalidation":"kapan setup batal","reasons":["alasan entry"]}}
atau "setup": null bila tidak ada setup.`;
}

export interface AiRawSetup {
  direction?: string;
  entry_type?: string;
  entry?: number;
  sl?: number;
  tp?: number;
  target_reason?: string;
  invalidation?: string;
  reasons?: string[];
}

export interface AiRaw {
  image_check?: { is_chart?: boolean; symbol?: string; timeframe?: string };
  bias?: string;
  structure?: string[];
  summary?: string;
  setup?: AiRawSetup | null;
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v.replace(/,/g, "")) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 300)).slice(0, 8) : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, 400) : undefined);

/** Ambil objek JSON dari jawaban model (boleh dibungkus ```json … ``` atau ada teks di sekitarnya). */
export function parseAiJson(text: string): AiRaw | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const ic = (o.image_check ?? {}) as Record<string, unknown>;
  const s = o.setup as Record<string, unknown> | null | undefined;
  return {
    image_check: { is_chart: typeof ic.is_chart === "boolean" ? ic.is_chart : undefined, symbol: str(ic.symbol), timeframe: str(ic.timeframe) },
    bias: str(o.bias),
    structure: strs(o.structure),
    summary: str(o.summary),
    setup:
      s && typeof s === "object"
        ? { direction: str(s.direction)?.toUpperCase(), entry_type: str(s.entry_type)?.toLowerCase(), entry: num(s.entry), sl: num(s.sl), tp: num(s.tp), target_reason: str(s.target_reason), invalidation: str(s.invalidation), reasons: strs(s.reasons) }
        : null,
  };
}

export interface AiSetup {
  direction: Direction;
  entryType: "market" | "limit";
  entry: number;
  sl: number;
  tp: number;
  rr: number;
  slPips: number;
  tpPips: number;
  targetReason: string | null;
  invalidation: string | null;
  reasons: string[];
}

export type AiValidation = { ok: true; setup: AiSetup; notes: string[] } | { ok: false; status: "no_setup" | "rejected"; reason: string; notes: string[] };

/** Level struktur terdekat dari harga `p` (level S/R ≥2 sentuhan atau high/low rentang) dalam toleransi. */
function nearStructure(p: number, ctx: AiContext, tol: number): string | null {
  const cands = [...ctx.levels.map((l) => ({ price: l.price, label: `${l.kind} ${l.tf} ${fmt(l.price)}` })), { price: ctx.rangeHigh, label: `high range ${fmt(ctx.rangeHigh)}` }, { price: ctx.rangeLow, label: `low range ${fmt(ctx.rangeLow)}` }];
  let best: { d: number; label: string } | null = null;
  for (const c of cands) {
    const d = Math.abs(c.price - p);
    if (d <= tol && (!best || d < best.d)) best = { d, label: c.label };
  }
  return best?.label ?? null;
}

/**
 * Validasi deterministik jawaban AI. Market → entry = harga sekarang. Limit di sisi yang sudah terlewati → market.
 * RR di luar 1:5–1:6: dipertahankan bila TP di level struktur (dan 1:4–1:8), selain itu TP digeser ke 1:5 / 1:6.
 */
export function validateAiSetup(raw: AiRaw, ctx: AiContext, spec: InstrumentSpec): AiValidation {
  const notes: string[] = [];
  if (raw.image_check?.is_chart === false) return { ok: false, status: "rejected", reason: "Gambar tidak terbaca sebagai chart harga.", notes };
  const s = raw.setup;
  if (!s) return { ok: false, status: "no_setup", reason: "AI tidak menemukan setup yang jelas di gambar ini.", notes };
  const direction = s.direction === "BUY" || s.direction === "SELL" ? s.direction : null;
  if (!direction) return { ok: false, status: "rejected", reason: "Arah setup tidak valid.", notes };
  if (s.sl == null || s.tp == null || (s.entry_type !== "market" && s.entry == null)) return { ok: false, status: "rejected", reason: "Angka entry/SL/TP tidak lengkap.", notes };
  const sign = direction === "BUY" ? 1 : -1;
  const atrTf = ctx.atr[ctx.tf] ?? ctx.atrRisk;

  let entryType: "market" | "limit" = s.entry_type === "market" ? "market" : "limit";
  let entry = entryType === "market" ? ctx.price : s.entry!;
  // limit di sisi harga yang sudah terlewati (BUY limit di atas harga) akan langsung terisi → market
  if (entryType === "limit" && sign * (ctx.price - entry) <= 0) {
    entryType = "market";
    entry = ctx.price;
    notes.push("Entry limit sudah terlewati harga → diperlakukan entry market.");
  }
  if (entryType === "limit" && Math.abs(entry - ctx.price) > AI_ENTRY_MAX_ATR * atrTf) {
    return { ok: false, status: "rejected", reason: `Entry ${fmt(entry)} terlalu jauh dari harga sekarang ${fmt(ctx.price)} (>${AI_ENTRY_MAX_ATR}× ATR ${ctx.tf}).`, notes };
  }
  if (!(sign * (entry - s.sl) > 0 && sign * (s.tp - entry) > 0)) {
    return { ok: false, status: "rejected", reason: `Urutan harga salah untuk ${direction} (SL ${fmt(s.sl)}, entry ${fmt(entry)}, TP ${fmt(s.tp)}).`, notes };
  }
  const risk = Math.abs(entry - s.sl);
  if (risk < AI_SL_ATR.min * ctx.atrRisk) return { ok: false, status: "rejected", reason: `SL terlalu dekat (${fmt(risk)} USD < ${AI_SL_ATR.min}× ATR ${fmt(ctx.atrRisk)}); mudah tersapu noise.`, notes };
  if (risk > AI_SL_ATR.max * ctx.atrRisk) return { ok: false, status: "rejected", reason: `SL terlalu jauh (${fmt(risk)} USD > ${AI_SL_ATR.max}× ATR ${fmt(ctx.atrRisk)}).`, notes };

  let tp = s.tp;
  let rr = Math.abs(tp - entry) / risk;
  let targetReason = s.target_reason ?? null;
  const [lo, hi] = AI_RR.target;
  if (rr < lo - 1e-9 || rr > hi + 1e-9) {
    const level = rr >= AI_RR.min && rr <= AI_RR.max ? nearStructure(tp, ctx, AI_LEVEL_TOL_ATR * atrTf) : null;
    if (level) {
      notes.push(`RR 1:${rr.toFixed(1)} dipertahankan: TP di level struktur (${level}).`);
    } else {
      const want = rr < lo ? lo : hi;
      tp = entry + sign * want * risk;
      notes.push(`TP digeser dari ${fmt(s.tp)} ke ${fmt(tp)} agar RR 1:${want} (RR AI 1:${rr.toFixed(1)} tanpa level struktur di TP).`);
      targetReason = `RR 1:${want} (disesuaikan)${targetReason ? `; usulan AI: ${targetReason}` : ""}`;
      rr = want;
    }
  }
  const r2 = (p: number) => roundTo(p, spec.digits);
  const e = r2(entry);
  const sl = r2(s.sl);
  const t = r2(tp);
  return {
    ok: true,
    notes,
    setup: {
      direction,
      entryType,
      entry: e,
      sl,
      tp: t,
      rr: roundTo(Math.abs(t - e) / Math.abs(e - sl), 2),
      slPips: priceToPips(Math.abs(e - sl), spec),
      tpPips: priceToPips(Math.abs(t - e), spec),
      targetReason,
      invalidation: s.invalidation ?? null,
      reasons: s.reasons ?? [],
    },
  };
}

export type AiPendingStatus = { status: "pending" } | { status: "entry_touched"; touchedSec: number } | { status: "expired" | "invalid"; atSec: number; reason: string };

/** Order limit menunggu: tersentuh, kedaluwarsa (AI_EXPIRY_BARS bar TF gambar), atau batal (TP/SL lebih dulu tanpa entry). */
export function aiPendingStatus(i: { direction: Direction; entry: number; sl: number; tp: number; createdSec: number; expiresSec: number; candles: (Candle & { span?: number })[]; barSec: number; nowSec: number }): AiPendingStatus {
  const s = i.direction === "BUY" ? 1 : -1;
  for (const c of i.candles) {
    if (c.time + (c.span ?? i.barSec) <= i.createdSec) continue;
    if (c.time >= i.expiresSec) break;
    const touched = s > 0 ? c.low <= i.entry : c.high >= i.entry;
    if (touched) return { status: "entry_touched", touchedSec: Math.max(c.time, i.createdSec) };
    const tpFirst = s > 0 ? c.high >= i.tp : c.low <= i.tp;
    if (tpFirst) return { status: "invalid", atSec: c.time, reason: "TP tercapai sebelum entry tersentuh." };
  }
  if (i.nowSec >= i.expiresSec) return { status: "expired", atSec: i.expiresSec, reason: `Entry tidak tersentuh dalam ${AI_EXPIRY_BARS} bar.` };
  return { status: "pending" };
}

export const aiExpirySec = (tf: AiTf, createdSec: number) => createdSec + AI_EXPIRY_BARS * TF_SECONDS[tf];

/** Hasil setup AI satu TP (tanpa BE): WIN di TP, LOSS di SL, TIMEOUT setelah AI_MAX_HOLD_SEC. */
export function aiOutcome(i: { direction: Direction; entry: number; sl: number; tp: number; entryTouchedAtSec: number; candles: (Candle & { span?: number })[]; barSec: number; price: number | null; nowSec: number; spec: InstrumentSpec }) {
  const r = evaluateOutcome({ direction: i.direction, entry: i.entry, sl: i.sl, tps: [i.tp, i.tp, i.tp], entryTouchedAtSec: i.entryTouchedAtSec, candles: i.candles, barSec: i.barSec, price: i.price, nowSec: i.nowSec, maxHoldSec: AI_MAX_HOLD_SEC, spec: i.spec });
  const riskPips = priceToPips(Math.abs(i.entry - i.sl), i.spec);
  if (r.outcome === "open") return { outcome: "open" as const, pips: null, r: null, closedAtSec: null, ambiguous: r.ambiguous, note: "Menunggu TP/SL." };
  const pips = r.outcome === "win" ? priceToPips(Math.abs(i.tp - i.entry), i.spec) : r.outcome === "loss" ? -riskPips : r.pips;
  const note = r.outcome === "win" ? "TP tersentuh." : r.outcome === "loss" ? (r.ambiguous ? "SL dan TP dalam candle yang sama — dihitung SL (konservatif)." : "SL tersentuh.") : "Batas waktu 3 hari tanpa TP/SL; hasil = harga terakhir.";
  return { outcome: r.outcome, pips, r: pips != null && riskPips ? roundTo(pips / riskPips, 2) : null, closedAtSec: r.closedAtSec, ambiguous: r.ambiguous, note };
}
