import type { Candle, Direction, EntryType, OpportunityStatus, MarketBias, StrategyId, Timeframe } from "./types.ts";
import { ACTIVE_STATUSES, TF_SECONDS } from "./types.ts";
import { TWO_WAY_STRATEGIES, type EngineConfig } from "./config.ts";
import type { SetupCandidate } from "./strategies.ts";
import { isBearishConfirmation, isBullishConfirmation } from "./structure.ts";
import { priceToPips, type InstrumentSpec } from "./instrument.ts";

/** Bentuk minimal setup tersimpan yang dibutuhkan untuk dedupe & lifecycle. */
export interface StoredSetup {
  id: string;
  identity_key: string;
  strategy: StrategyId;
  direction: Direction;
  timeframe: Timeframe;
  confirm_tf: Timeframe;
  entry_type: EntryType;
  entry_price: number;
  entry_low: number;
  entry_high: number;
  invalidation: number;
  sl: number;
  /** TP1 — untuk aturan "peluang terlewat" (harga sampai TP1 sebelum entry tersentuh) */
  tp1?: number;
  created_at_sec: number;
  expires_at_sec: number;
  status: OpportunityStatus;
  eligible: boolean;
  confirmed_at_sec: number | null;
  entry_touched_at_sec: number | null;
  /** hasil sinyal menurut feed & TP tertinggi tercapai (untuk aturan pengiriman 1 sinyal sekaligus) */
  outcome?: string | null;
  outcome_tp?: number | null;
  outcome_pips?: number | null;
  /** dikecualikan pengguna dari statistik/rekap */
  excluded?: boolean;
}

export type DedupeVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Deduplikasi tanpa jeda panjang tetap:
 *  1. identity_key sama (pola yang sama) → tolak selamanya.
 *  2. setup AKTIF dengan strategi+arah+TF sama dan entry < dedupePips → duplikat.
 *  3. cooldown pendek (cooldownBars × TF) antar setup baru strategi+arah+TF sama,
 *     kecuali entry berbeda jauh (≥ 2 × dedupePips) — peluang baru tidak dibuang.
 */
export function dedupeCandidate(
  cand: SetupCandidate,
  existing: StoredSetup[],
  cfg: EngineConfig,
): DedupeVerdict {
  if (existing.some((e) => e.identity_key === cand.identityKey)) return { ok: false, reason: "Identitas setup sudah ada" };
  const same = existing.filter((e) => e.strategy === cand.strategy && e.direction === cand.direction && e.timeframe === cand.timeframe);
  const pips = (a: number, b: number) => priceToPips(Math.abs(a - b), cfg.spec);
  const activeNear = same.find((e) => ACTIVE_STATUSES.includes(e.status) && pips(e.entry_price, cand.entry) < cfg.dedupePips);
  if (activeNear) return { ok: false, reason: `Setup aktif serupa (${activeNear.id}) dalam ${cfg.dedupePips} pips` };
  const cooldown = cfg.cooldownBars * TF_SECONDS[cand.timeframe];
  const recent = same.find((e) => cand.createdAt - e.created_at_sec < cooldown && pips(e.entry_price, cand.entry) < 2 * cfg.dedupePips);
  if (recent) return { ok: false, reason: `Cooldown ${cfg.cooldownBars} bar ${cand.timeframe} untuk pola serupa` };
  return { ok: true };
}

/** Dedupe antar kandidat dalam satu run (ambil skor tertinggi per kelompok). */
export function dedupeBatch(cands: SetupCandidate[], cfg: EngineConfig): SetupCandidate[] {
  const sorted = [...cands].sort((a, b) => b.score.total - a.score.total);
  const kept: SetupCandidate[] = [];
  for (const c of sorted) {
    const clash = kept.some(
      (k) =>
        k.identityKey === c.identityKey ||
        (k.direction === c.direction && k.timeframe === c.timeframe && priceToPips(Math.abs(k.entry - c.entry), cfg.spec) < cfg.dedupePips),
    );
    if (!clash) kept.push(c);
  }
  return kept;
}

export interface StatusUpdate {
  status: OpportunityStatus;
  reason: string;
  confirmedAt: number | null;
  entryTouchedAt: number | null;
  /** event yang terjadi pada evaluasi ini (untuk notifikasi & histori) */
  events: ("confirmed" | "entry_touched" | "invalid" | "expired" | "approaching" | "in_area")[];
}

/**
 * Evaluasi status peluang. Status peluang terpisah dari jurnal:
 * "entry tersentuh" pada feed TIDAK berarti pengguna membuka posisi.
 *
 * - Invalid: candle `confirm_tf` TERTUTUP setelah setup dibuat menutup melewati invalidasi,
 *   atau bias utama berbalik berlawanan.
 * - Kedaluwarsa: melewati expires_at sebelum entry tersentuh.
 * - Entry tersentuh: harga feed (termasuk high/low intrabar sejak setup dibuat) menyentuh entry.
 * - Menunggu konfirmasi: harga di dalam area entry, belum ada candle konfirmasi.
 * - Mendekati area: selain itu.
 */
export function evaluateStatus(
  s: StoredSetup,
  args: {
    nowSec: number;
    price: number | null;
    /** candle TF konfirmasi (boleh termasuk bar berjalan untuk sentuhan intrabar) */
    confirmCandles: Candle[];
    /** candle halus (M5) untuk mencatat waktu sentuhan yang sebenarnya, bukan waktu deteksi */
    touchCandles?: Candle[];
    mainBias: MarketBias;
    dataOk: boolean;
  },
): StatusUpdate {
  const base: StatusUpdate = {
    status: s.status,
    reason: "",
    confirmedAt: s.confirmed_at_sec,
    entryTouchedAt: s.entry_touched_at_sec,
    events: [],
  };
  if (s.status === "invalid" || s.status === "expired" || s.status === "entry_touched") return base;
  const sign = s.direction === "BUY" ? 1 : -1;
  const step = TF_SECONDS[s.confirm_tf];
  const since = args.confirmCandles.filter((c) => c.time >= s.created_at_sec - (s.created_at_sec % step));
  const closedSince = since.filter((c) => c.time + step <= args.nowSec);

  // 1) invalidasi oleh close candle
  const broke = closedSince.find((c) => sign * (c.close - s.invalidation) <= 0);
  if (broke) {
    return { ...base, status: "invalid", reason: `Candle ${s.confirm_tf} ditutup ${broke.close.toFixed(2)} melewati invalidasi ${s.invalidation.toFixed(2)}.`, events: ["invalid"] };
  }
  // strategi dua arah (MSNR flip, FVG retest) sengaja boleh melawan bias utama, jadi tidak dibatalkan oleh bias; invalidasi struktur di atas tetap berlaku
  if (!TWO_WAY_STRATEGIES.includes(s.strategy) && ((s.direction === "BUY" && args.mainBias === "bearish") || (s.direction === "SELL" && args.mainBias === "bullish"))) {
    return { ...base, status: "invalid", reason: `Bias utama berbalik ${args.mainBias}.`, events: ["invalid"] };
  }

  // 2) sentuhan entry (intrabar diperbolehkan), hanya bila data valid
  if (args.dataOk) {
    // Bar tempat setup dibuat tidak dipakai (rentangnya bisa berisi harga sebelum setup ada).
    const after = since.filter((c) => c.time > s.created_at_sec);
    const hit = (hi: number, lo: number) => {
      const wantsUp = (s.entry_type === "stop") === (s.direction === "BUY");
      return wantsUp ? hi >= s.entry_price : lo <= s.entry_price;
    };
    // candle M5 pertama yang menyentuh → waktu sentuhan (candle M15 Twelve Data baru masuk saat bar tutup)
    const fine = (args.touchCandles ?? []).find((c) => c.time > s.created_at_sec && hit(c.high, c.low));

    // peluang terlewat: harga sudah mencapai TP1 sebelum entry tersentuh → batal (permintaan pengguna 20 Okt 2026).
    // Urutan dibaca dari M5 bila ada (lebih halus); entry & TP1 di candle yang sama dihitung entry tersentuh.
    const tp1 = s.tp1;
    if (s.entry_type !== "market" && tp1 != null && Number.isFinite(tp1)) {
      const tpHit = (hi: number, lo: number) => (s.direction === "BUY" ? hi >= tp1 : lo <= tp1);
      const bars = (args.touchCandles?.length ? args.touchCandles : after).filter((c) => c.time > s.created_at_sec);
      const first = (f: (hi: number, lo: number) => boolean) => bars.find((c) => f(c.high, c.low))?.time ?? Infinity;
      const tEntry = first(hit);
      const tTp = first(tpHit);
      const tickPast = tEntry === Infinity && args.price != null && tpHit(args.price, args.price) && !hit(args.price, args.price);
      if (tTp < tEntry || tickPast) {
        return { ...base, status: "invalid", reason: `Peluang terlewat: harga sudah mencapai TP1 ${tp1.toFixed(2)} sebelum entry ${s.entry_price.toFixed(2)} tersentuh.`, events: ["invalid"] };
      }
    }
    const touched =
      s.entry_type === "market" ||
      fine != null ||
      after.some((c) => hit(c.high, c.low)) ||
      (args.price != null && hit(args.price, args.price));
    if (touched) {
      const at = fine ? Math.min(fine.time, args.nowSec) : args.nowSec;
      return { ...base, status: "entry_touched", entryTouchedAt: at, reason: "Harga feed menyentuh entry (bukan berarti posisi dibuka).", events: ["entry_touched"] };
    }
  }

  // 3) kedaluwarsa
  if (args.nowSec >= s.expires_at_sec) {
    return { ...base, status: "expired", reason: "Melewati batas waktu sebelum entry tersentuh.", events: ["expired"] };
  }

  // 4) konfirmasi candle tertutup di area
  const events: StatusUpdate["events"] = [];
  let confirmedAt = s.confirmed_at_sec;
  if (confirmedAt == null) {
    for (let i = 1; i < closedSince.length; i++) {
      const c = closedSince[i];
      const p = closedSince[i - 1];
      const inArea = s.direction === "BUY" ? c.low <= s.entry_high && c.close >= s.entry_low : c.high >= s.entry_low && c.close <= s.entry_high;
      const pattern = s.direction === "BUY" ? isBullishConfirmation(p, c) : isBearishConfirmation(p, c);
      if (inArea && pattern) {
        confirmedAt = c.time + step;
        events.push("confirmed");
        break;
      }
    }
  }

  const inArea = args.price != null && args.price >= s.entry_low && args.price <= s.entry_high;
  const status: OpportunityStatus = inArea && confirmedAt == null ? "awaiting_confirmation" : "approaching";
  if (status !== s.status) events.push(status === "awaiting_confirmation" ? "in_area" : "approaching");
  return {
    ...base,
    status,
    confirmedAt,
    reason: status === "awaiting_confirmation" ? "Harga di area entry, menunggu candle konfirmasi tertutup." : confirmedAt ? "Konfirmasi terpenuhi, menunggu harga menyentuh entry." : "Harga belum di area entry.",
    events,
  };
}

export function distanceToEntryPips(price: number, entry: number, spec: InstrumentSpec): number {
  return priceToPips(Math.abs(price - entry), spec);
}

export const OPPORTUNITY_STATUS_LABEL: Record<OpportunityStatus, string> = {
  approaching: "Mendekati area",
  awaiting_confirmation: "Menunggu konfirmasi",
  entry_touched: "Entry tersentuh",
  invalid: "Invalid",
  expired: "Kedaluwarsa",
};
