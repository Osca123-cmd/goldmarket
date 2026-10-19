import type { Candle, Direction } from "./types.ts";
import { priceToPips, type InstrumentSpec } from "./instrument.ts";

/**
 * Hasil SINYAL menurut feed (Riwayat Sinyal) — terpisah dari jurnal pengguna.
 *
 * Aturan (didokumentasikan di docs/STRATEGY.md §10):
 *  - Pelacakan dimulai saat entry tersentuh menurut feed. TP di candle tempat
 *    entry tersentuh tidak dihitung (bisa terjadi sebelum entry); SL tetap.
 *  - Setelah TP1 tersentuh, SL dipindah ke entry (BE).
 *  - WIN  : minimal TP1 tersentuh. Sinyal ditutup saat harga kembali ke entry (BE),
 *           TP3 tersentuh, atau batas waktu. Hasil = pips TP tertinggi yang tersentuh.
 *  - LOSS : SL tersentuh sebelum TP1. Hasil = −pips SL.
 *  - SL dan TP tersentuh dalam candle yang sama tanpa data lebih rinci →
 *    dihitung konservatif sebagai SL untuk TP tersebut (ambigu ditandai).
 *  - Batas waktu tanpa TP1 maupun SL → TIMEOUT, hasil = pips harga terakhir.
 *  - Biaya (spread/komisi/slippage) tidak dikurangkan; ini hasil level sinyal,
 *    bukan hasil transaksi riil.
 */
export type SignalOutcome = "open" | "win" | "loss" | "timeout";

export interface OutcomeInput {
  direction: Direction;
  entry: number;
  sl: number;
  tps: [number, number, number];
  entryTouchedAtSec: number;
  /** candle sejak entry tersentuh (boleh termasuk bar berjalan) */
  candles: Candle[];
  /** durasi bar candle (detik) */
  barSec: number;
  price: number | null;
  nowSec: number;
  maxHoldSec: number;
  spec: InstrumentSpec;
  /** TP tertinggi yang sudah tercatat sebelumnya — tidak boleh turun bila candle sempat kosong/tertunda */
  tpHitBefore?: 0 | 1 | 2 | 3;
  /** kapan tpHitBefore tercatat; BE dari TP itu berlaku sejak waktu ini (tanpa nilai: setelah semua candle) */
  tpHitBeforeAtSec?: number | null;
}

export interface OutcomeResult {
  outcome: SignalOutcome;
  tpHit: 0 | 1 | 2 | 3;
  pips: number | null;
  ambiguous: boolean;
  closedAtSec: number | null;
  /** waktu tpHit tertinggi pertama tersentuh (awal candle / waktu tick) */
  tpAtSec: number | null;
  note: string;
}

export function evaluateOutcome(i: OutcomeInput): OutcomeResult {
  const s = i.direction === "BUY" ? 1 : -1;
  const pipsOf = (price: number) => priceToPips(s * (price - i.entry), i.spec);
  const slPips = -Math.abs(pipsOf(i.sl));
  let tpHit: 0 | 1 | 2 | 3 = 0;
  let tpAt: number | null = null;
  // TP tercatat sebelumnya (mis. dari tick yang tidak terlihat di candle) berlaku sejak waktu tercatatnya,
  // jadi BE tidak aktif mundur ke waktu entry
  const floor = () => {
    if ((i.tpHitBefore ?? 0) > tpHit) {
      tpHit = i.tpHitBefore!;
      tpAt = i.tpHitBeforeAtSec ?? null;
    }
  };
  const floorFrom = i.tpHitBeforeAtSec ?? Infinity;
  let ambiguous = false;
  // bar tempat entry tersentuh ikut dihitung (rentangnya bisa memuat SL/TP setelah sentuhan)
  const bars = i.candles.filter((c) => c.time + i.barSec > i.entryTouchedAtSec);
  // candle sentuhan bisa memuat harga sebelum entry → TP di candle itu tidak dihitung (SL tetap)
  const points: { hi: number; lo: number; t: number; touchBar: boolean; tick?: boolean }[] = bars.map((c) => ({ hi: c.high, lo: c.low, t: c.time, touchBar: c.time <= i.entryTouchedAtSec }));
  if (i.price != null) points.push({ hi: i.price, lo: i.price, t: i.nowSec, touchBar: false, tick: true });

  const backAtEntry = (p: { hi: number; lo: number }) => (s > 0 ? p.lo <= i.entry : p.hi >= i.entry);
  for (const p of points) {
    if (p.tick || p.t + (p.tick ? 0 : i.barSec) > floorFrom) floor();
    // setelah TP1, SL berada di entry (BE)
    const stopHit = tpHit > 0 ? backAtEntry(p) : s > 0 ? p.lo <= i.sl : p.hi >= i.sl;
    let reached: 0 | 1 | 2 | 3 = tpHit;
    for (let k = 0; !p.touchBar && k < 3; k++) {
      const tp = i.tps[k];
      if (s > 0 ? p.hi >= tp : p.lo <= tp) reached = Math.max(reached, k + 1) as 0 | 1 | 2 | 3;
    }
    if (stopHit && reached > tpHit) {
      // urutan dalam candle tidak diketahui → konservatif: TP baru di candle ini tidak dihitung
      ambiguous = true;
      reached = tpHit;
    }
    const firstTp = tpHit === 0 && reached > 0;
    if (reached > tpHit) tpAt = p.t;
    tpHit = reached;
    if (stopHit) {
      if (tpHit === 0) return { outcome: "loss", tpHit: 0, pips: slPips, ambiguous, closedAtSec: p.t, tpAtSec: tpAt, note: ambiguous ? "SL dan TP dalam candle yang sama — dihitung SL (konservatif)." : "SL tersentuh sebelum TP1." };
      return { outcome: "win", tpHit, pips: pipsOf(i.tps[tpHit - 1]), ambiguous, closedAtSec: p.t, tpAtSec: tpAt, note: `TP${tpHit} tersentuh, lalu harga kembali ke entry (SL di BE).` };
    }
    if (firstTp && backAtEntry(p)) {
      // TP pertama dan entry dalam candle yang sama → urutan tidak diketahui; konservatif hanya TP1 lalu BE
      return { outcome: "win", tpHit: 1, pips: pipsOf(i.tps[0]), ambiguous: true, closedAtSec: p.t, tpAtSec: tpAt, note: "TP dan entry dalam candle yang sama — dihitung TP1 lalu BE (konservatif)." };
    }
    if (tpHit === 3) return { outcome: "win", tpHit, pips: pipsOf(i.tps[2]), ambiguous, closedAtSec: p.t, tpAtSec: tpAt, note: "TP3 tersentuh." };
  }
  floor();

  if (i.nowSec - i.entryTouchedAtSec >= i.maxHoldSec) {
    if (tpHit > 0) return { outcome: "win", tpHit, pips: pipsOf(i.tps[tpHit - 1]), ambiguous, closedAtSec: i.nowSec, tpAtSec: tpAt, note: `Batas waktu; TP${tpHit} sudah tersentuh.` };
    const last = i.price ?? bars[bars.length - 1]?.close ?? i.entry;
    return { outcome: "timeout", tpHit: 0, pips: pipsOf(last), ambiguous, closedAtSec: i.nowSec, tpAtSec: tpAt, note: "Batas waktu tanpa TP1/SL; hasil = harga terakhir." };
  }
  return { outcome: "open", tpHit, pips: null, ambiguous, closedAtSec: null, tpAtSec: tpAt, note: tpHit ? `TP${tpHit} tersentuh, SL di BE (entry). Pelacakan berlanjut.` : "Menunggu TP/SL." };
}

/** Grade tampilan dari skor kualitas (bukan probabilitas). */
export function gradeOf(score: number | null | undefined): string | null {
  if (score == null) return null;
  if (score >= 80) return "A+";
  if (score >= 70) return "A";
  if (score >= 60) return "B";
  return "C";
}
