import type { Candle, Direction } from "./types.ts";
import { priceToPips, type InstrumentSpec } from "./instrument.ts";

/**
 * Hasil SINYAL menurut feed (Riwayat Sinyal) — terpisah dari jurnal pengguna.
 *
 * Aturan (didokumentasikan di docs/STRATEGY.md §10):
 *  - Pelacakan dimulai saat entry tersentuh menurut feed. TP di candle tempat
 *    entry tersentuh tidak dihitung (bisa terjadi sebelum entry); SL tetap.
 *  - Setelah TP1 tersentuh, SL dipindah ke entry (BE); setelah TP2, SL dipindah ke TP1
 *    (permintaan pengguna 21 Okt 2026).
 *  - WIN  : minimal TP1 tersentuh. Sinyal ditutup saat harga kembali ke SL berjalan (entry / TP1),
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
  /** candle sejak entry tersentuh (boleh termasuk bar berjalan); boleh campuran M1/M5 dengan `span` per bar */
  candles: (Candle & { span?: number })[];
  /** durasi bar candle (detik) bila bar tidak membawa `span` */
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

/**
 * Gabungkan candle kasar (M5) dengan candle halus (M1) untuk pelacakan hasil (23 Okt 2026): bar M5 yang seluruh
 * isinya tersedia di M1 diganti bar-bar M1 (urutan harga di dalam M5 jadi diketahui, TP/SL terdeteksi per menit);
 * bar M5 yang masih berjalan diganti M1 yang sudah ada; bar M5 tanpa M1 tetap dipakai apa adanya. Bar M1 sesudah
 * bar M5 terakhir (M5-nya belum masuk) ikut dipakai. Setiap bar diberi `span` (detik).
 */
export function mergeFineCandles(coarse: Candle[], coarseSec: number, fine: Candle[], fineSec: number): (Candle & { span: number })[] {
  const byTime = new Map(fine.map((c) => [c.time, c]));
  const lastFine = fine.length ? Math.max(...fine.map((c) => c.time)) : -Infinity;
  const out: (Candle & { span: number })[] = [];
  for (const c of coarse) {
    const parts: Candle[] = [];
    for (let t = c.time; t < c.time + coarseSec; t += fineSec) {
      const f = byTime.get(t);
      if (!f) break;
      parts.push(f);
    }
    const full = parts.length === coarseSec / fineSec;
    const runningCovered = parts.length > 0 && parts[parts.length - 1].time === lastFine;
    if (full || runningCovered) out.push(...parts.map((p) => ({ ...p, span: fineSec })));
    else out.push({ ...c, span: coarseSec });
  }
  const end = coarse.length ? coarse[coarse.length - 1].time + coarseSec : -Infinity;
  for (const f of fine) if (f.time >= end) out.push({ ...f, span: fineSec });
  return out.sort((a, b) => a.time - b.time);
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
  const bars = i.candles.filter((c) => c.time + (c.span ?? i.barSec) > i.entryTouchedAtSec);
  // candle sentuhan bisa memuat harga sebelum entry → TP di candle itu tidak dihitung (SL tetap)
  const points: { hi: number; lo: number; t: number; touchBar: boolean; tick?: boolean }[] = bars.map((c) => ({ hi: c.high, lo: c.low, t: c.time, touchBar: c.time <= i.entryTouchedAtSec }));
  if (i.price != null) points.push({ hi: i.price, lo: i.price, t: i.nowSec, touchBar: false, tick: true });

  const backAtEntry = (p: { hi: number; lo: number }) => (s > 0 ? p.lo <= i.entry : p.hi >= i.entry);
  // SL berjalan: setelah TP1 di entry (BE), setelah TP2 di TP1
  const trailStop = (hit: number) => (hit >= 2 ? i.tps[hit - 2] : i.entry);
  const backAtTrail = (p: { hi: number; lo: number }, hit: number) => (s > 0 ? p.lo <= trailStop(hit) : p.hi >= trailStop(hit));
  for (const p of points) {
    // TP tercatat berlaku mulai candle SESUDAH waktu tercatatnya (candle itu sendiri bisa memuat harga sebelum TP)
    if (p.tick || p.t >= floorFrom) floor();
    // setelah TP1, SL berada di entry (BE); setelah TP2 di TP1
    const stopAt = tpHit;
    const stopHit = tpHit > 0 ? backAtTrail(p, tpHit) : s > 0 ? p.lo <= i.sl : p.hi >= i.sl;
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
      const back = stopAt >= 2 ? `TP${stopAt - 1} (SL dipindah ke TP${stopAt - 1} setelah TP${stopAt})` : "entry (SL di BE)";
      return { outcome: "win", tpHit, pips: pipsOf(i.tps[tpHit - 1]), ambiguous, closedAtSec: p.t, tpAtSec: tpAt, note: `TP${tpHit} tersentuh, lalu harga kembali ke ${back}.` };
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
  return { outcome: "open", tpHit, pips: null, ambiguous, closedAtSec: null, tpAtSec: tpAt, note: tpHit ? `TP${tpHit} tersentuh, SL di ${tpHit >= 2 ? `TP${tpHit - 1}` : "BE (entry)"}. Pelacakan berlanjut.` : "Menunggu TP/SL." };
}

/** Grade tampilan dari skor kualitas (bukan probabilitas). */
export function gradeOf(score: number | null | undefined): string | null {
  if (score == null) return null;
  if (score >= 80) return "A+";
  if (score >= 70) return "A";
  if (score >= 60) return "B";
  return "C";
}
