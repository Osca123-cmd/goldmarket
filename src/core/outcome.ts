import type { Candle, Direction } from "./types.ts";
import { priceToPips, type InstrumentSpec } from "./instrument.ts";

/**
 * Hasil SINYAL menurut feed (Riwayat Sinyal) — terpisah dari jurnal pengguna.
 *
 * Aturan (didokumentasikan di docs/STRATEGY.md §10):
 *  - Pelacakan dimulai saat entry tersentuh menurut feed.
 *  - WIN  : minimal TP1 tersentuh sebelum SL. Hasil = pips TP tertinggi yang
 *           tersentuh sebelum SL / TP3 / batas waktu.
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
}

export interface OutcomeResult {
  outcome: SignalOutcome;
  tpHit: 0 | 1 | 2 | 3;
  pips: number | null;
  ambiguous: boolean;
  closedAtSec: number | null;
  note: string;
}

export function evaluateOutcome(i: OutcomeInput): OutcomeResult {
  const s = i.direction === "BUY" ? 1 : -1;
  const pipsOf = (price: number) => priceToPips(s * (price - i.entry), i.spec);
  const slPips = -Math.abs(pipsOf(i.sl));
  let tpHit: 0 | 1 | 2 | 3 = 0;
  let ambiguous = false;
  // bar tempat entry tersentuh ikut dihitung (rentangnya bisa memuat SL/TP setelah sentuhan)
  const bars = i.candles.filter((c) => c.time + i.barSec > i.entryTouchedAtSec);
  const points: { hi: number; lo: number; t: number }[] = bars.map((c) => ({ hi: c.high, lo: c.low, t: c.time }));
  if (i.price != null) points.push({ hi: i.price, lo: i.price, t: i.nowSec });

  for (const p of points) {
    const slHit = s > 0 ? p.lo <= i.sl : p.hi >= i.sl;
    let reached: 0 | 1 | 2 | 3 = tpHit;
    for (let k = 0; k < 3; k++) {
      const tp = i.tps[k];
      if (s > 0 ? p.hi >= tp : p.lo <= tp) reached = Math.max(reached, k + 1) as 0 | 1 | 2 | 3;
    }
    if (slHit && reached > tpHit) {
      // urutan dalam candle tidak diketahui → konservatif: TP baru di candle ini tidak dihitung
      ambiguous = true;
      reached = tpHit;
    }
    tpHit = reached;
    if (slHit) {
      if (tpHit === 0) return { outcome: "loss", tpHit: 0, pips: slPips, ambiguous, closedAtSec: p.t, note: ambiguous ? "SL dan TP dalam candle yang sama — dihitung SL (konservatif)." : "SL tersentuh sebelum TP1." };
      return { outcome: "win", tpHit, pips: pipsOf(i.tps[tpHit - 1]), ambiguous, closedAtSec: p.t, note: `TP${tpHit} tersentuh, lalu SL.` };
    }
    if (tpHit === 3) return { outcome: "win", tpHit, pips: pipsOf(i.tps[2]), ambiguous, closedAtSec: p.t, note: "TP3 tersentuh." };
  }

  if (i.nowSec - i.entryTouchedAtSec >= i.maxHoldSec) {
    if (tpHit > 0) return { outcome: "win", tpHit, pips: pipsOf(i.tps[tpHit - 1]), ambiguous, closedAtSec: i.nowSec, note: `Batas waktu; TP${tpHit} sudah tersentuh.` };
    const last = i.price ?? bars[bars.length - 1]?.close ?? i.entry;
    return { outcome: "timeout", tpHit: 0, pips: pipsOf(last), ambiguous, closedAtSec: i.nowSec, note: "Batas waktu tanpa TP1/SL; hasil = harga terakhir." };
  }
  return { outcome: "open", tpHit, pips: null, ambiguous, closedAtSec: null, note: tpHit ? `TP${tpHit} tersentuh, pelacakan berlanjut.` : "Menunggu TP/SL." };
}

/** Grade tampilan dari skor kualitas (bukan probabilitas). */
export function gradeOf(score: number | null | undefined): string | null {
  if (score == null) return null;
  if (score >= 80) return "A+";
  if (score >= 70) return "A";
  if (score >= 60) return "B";
  return "C";
}
