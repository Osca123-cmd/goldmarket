import type { EntryType, StopKind, StrategyId, Timeframe } from "./types.ts";
import { DEFAULT_PIP_PLAN, DEFAULT_XAUUSD, type InstrumentSpec, type PipPlan } from "./instrument.ts";
import { DEFAULT_THRESHOLDS, type QualityThresholds } from "./dataQuality.ts";

/** Pasangan timeframe konteks setup → timeframe konfirmasi entry. */
export interface TfPair {
  context: Timeframe;
  confirm: Timeframe;
}

export interface EngineConfig {
  spec: InstrumentSpec;
  /** rencana pips default (dipakai bila TF tidak punya rencana sendiri) */
  plan: PipPlan;
  /**
   * Rencana SL/TP per timeframe konteks. Pada harga emas ±$4.000, SL 50 pips ($5)
   * lebih kecil dari ATR H1 di hari kerja, sehingga H1 memakai rencana sendiri.
   */
  planByTf: Partial<Record<Timeframe, PipPlan>>;
  thresholds: QualityThresholds;
  /** bias utama: TF besar (major) + TF pendukung (minor) — sejak 19 Okt 2026: H1 + M30 */
  biasTfs: { major: Timeframe; minor: Timeframe };
  /** TF tambahan yang dianalisis HANYA untuk info & bonus skor tren (bukan filter, tidak ikut cek kualitas data). Sejak 20 Okt 2026: H4. */
  infoTf?: Timeframe;
  pairs: TfPair[];
  strategies: StrategyId[];
  /** skor minimum agar engine menyimpan setup (filter per pengguna bisa lebih ketat) */
  engineMinScore: number;
  /** skor minimum default per timeframe konteks (dipakai notifikasi & filter default) */
  minScoreByTf: Partial<Record<Timeframe, number>>;
  /** RR minimum pada TP2 setelah biaya spread (syarat wajib kelayakan risiko) */
  minRrAfterCost: number;
  /** SL minimum dalam kelipatan ATR timeframe konfirmasi (di bawahnya = noise); tidak dipakai bila TF konfirmasi = TF konteks */
  minSlAtrConfirm: number;
  /** SL minimum dalam kelipatan ATR timeframe konteks */
  minSlAtrContext: number;
  /** masa berlaku setup dalam jumlah bar timeframe konteks */
  expiryBars: Record<StrategyId, number>;
  /** setup aktif dengan arah+strategi+TF sama dan entry dalam jarak ini dianggap duplikat */
  dedupePips: number;
  /** jeda minimum (bar TF konteks) antar setup baru dengan arah+strategi+TF sama */
  cooldownBars: number;
  /** jarak maksimum harga ke area entry (× ATR konteks) agar setup dibuat */
  maxDistanceAtr: number;
  /** tidak membuat setup baru ±N menit di sekitar rilis FOMC/NFP/CPI/PPI (0 = nonaktif) */
  newsBlackoutMin: number;
  /** SL tetap boleh berada maks. N pips di dalam invalidasi struktur (0 = ketat). Riset di backtest dulu sebelum dinaikkan untuk live. */
  invalidationTolPips: number;
  /**
   * Kedalaman entry limit di dalam zona per strategi: 0 = tepi dekat (default), 0,5 = tengah, 1 = tepi jauh.
   * 20 Okt 2026 (uji candle nyata 30 Agu–19 Okt, aturan "peluang terlewat" dari TP1 entry baru): FVG tepi jauh
   * 47 trade +12/sinyal → 27 trade +26/sinyal (net +549 → +699); Order Block tengah zona malah lebih jelek
   * (18 trade +45 → 11 trade +41), jadi OB tetap di tepi dekat.
   */
  limitDepth?: Partial<Record<StrategyId, number>>;
  /**
   * "Kandang babi": bila `bars` candle TF bias besar (H1) terakhir terkurung dalam ≤ `maxAtr` × ATR, H1 diperlakukan
   * ranging khusus untuk Supply/Demand reversal; strategi lain tidak berubah. 20 Okt 2026 (uji candle nyata
   * 30 Agu–19 Okt, 4 strategi live): 332 trade +4.494 (+13,5/sinyal) → 422 trade +6.534 (+15,5/sinyal),
   * lebih baik di kedua paruh periode. Memblokir strategi ikut-tren di dalam kotak tidak membantu.
   */
  /** tf = TF kotak (default TF bias besar); dipatok H1 sejak bias besar pindah ke H4 (21 Okt) karena kotak diuji di H1 */
  chopRanging?: { bars: number; maxAtr: number; tf?: Timeframe };
  /**
   * Arah sinyal dari setup & momentum, bukan dipaksa tren besar (permintaan pengguna 20 Okt 2026 malam):
   *  - twoWay: strategi yang juga dicari melawan bias utama dan tidak dibatalkan saat bias berbalik;
   *  - momentum: hanya arah EMA cepat vs lambat di TF kecil (BUY bila EMA cepat di atas).
   * Uji candle nyata 30 Agu–19 Okt (4 strategi live): 419 trade +6.833 (+16,3/sinyal, drawdown 854) →
   * 284 trade +7.528 (+26,5/sinyal, win 58%, drawdown 523), lebih baik di kedua paruh periode.
   */
  direction?: { twoWay: StrategyId[]; momentum?: { tf: Timeframe; fast: number; slow: number } };
  /** aturan PENGIRIMAN sinyal live (bukan deteksi; tidak memengaruhi backtest). Tidak diisi = nonaktif. */
  delivery?: DeliveryRules;
}

/** Jendela jam lokal dengan aturan khusus, mis. 14.00–17.00 WIB: hanya stop/market, maks 1 sinyal per hari. */
export interface DeliveryWindow {
  label: string;
  startHour: number;
  endHour: number;
  utcOffsetHours: number;
  entryTypes: EntryType[];
  maxPerDay: number;
}

export interface QuietHours {
  label: string;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  utcOffsetHours: number;
}

export interface DeliveryRules {
  /** hanya 1 sinyal hidup sekaligus (READY belum kena entry, atau berjalan sebelum TP1) */
  oneAtATime?: boolean;
  /** jenis entry yang dikirim (sepanjang hari); tidak diisi = semua */
  entryTypes?: EntryType[];
  /** jenis entry stop yang dikirim; tidak diisi = semua. 20 Okt: hanya back_to_zone (in_zone = sumber rugi stop live). */
  stopKinds?: StopKind[];
  /** jam istirahat: tidak ada sinyal baru (boleh melewati tengah malam); rekap hari dikirim saat mulai */
  quiet?: QuietHours;
  windows?: DeliveryWindow[];
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  spec: DEFAULT_XAUUSD,
  plan: DEFAULT_PIP_PLAN,
  planByTf: {
    M15: DEFAULT_PIP_PLAN,
    M30: { slPips: 70, tp1Pips: 70, tp2Pips: 140, tp3Pips: 210 },
    H1: { slPips: 100, tp1Pips: 100, tp2Pips: 200, tp3Pips: 300 },
  },
  thresholds: DEFAULT_THRESHOLDS,
  // 21 Okt 2026 (permintaan pengguna): bias H4+M30, setup M15 & M30, konfirmasi candle M15; H1 hanya untuk kotak "kandang babi".
  // Uji 1–19 Okt (9 strategi): H1/M30 244 trade +4.738 (+19,4/sinyal) vs H4/M30 236 trade +4.432 (+18,8/sinyal).
  biasTfs: { major: "H4", minor: "M30" },
  // H4 sudah jadi tren utama → tidak ada TF info terpisah
  infoTf: undefined,
  pairs: [
    { context: "M15", confirm: "M15" },
    { context: "M30", confirm: "M15" },
  ],
  strategies: ["trend_pullback", "breakout_retest"],
  engineMinScore: 40,
  minScoreByTf: { M15: 60, M30: 60, H1: 60 },
  minRrAfterCost: 1.5,
  minSlAtrConfirm: 0.8,
  minSlAtrContext: 0.75,
  expiryBars: { trend_pullback: 16, breakout_retest: 12, liquidity_sweep: 8, sd_reversal: 8, crt: 8, msnr_flip: 12, fvg_retest: 12, order_block: 12, chop_breakout: 6 },
  dedupePips: 30,
  cooldownBars: 2,
  maxDistanceAtr: 1.5,
  newsBlackoutMin: 30,
  invalidationTolPips: 0,
  limitDepth: { fvg_retest: 1 },
  chopRanging: { bars: 4, maxAtr: 2, tf: "H1" },
  direction: { twoWay: ["crt", "fvg_retest", "order_block", "chop_breakout"], momentum: { tf: "M15", fast: 8, slow: 21 } },
};

export function mergeConfig(partial: Partial<EngineConfig> | null | undefined): EngineConfig {
  if (!partial) return DEFAULT_ENGINE_CONFIG;
  return {
    ...DEFAULT_ENGINE_CONFIG,
    ...partial,
    spec: { ...DEFAULT_ENGINE_CONFIG.spec, ...(partial.spec ?? {}) },
    plan: { ...DEFAULT_ENGINE_CONFIG.plan, ...(partial.plan ?? {}) },
    planByTf: Object.fromEntries(
      [...new Set([...Object.keys(DEFAULT_ENGINE_CONFIG.planByTf), ...Object.keys(partial.planByTf ?? {})])].map((tf) => [
        tf,
        { ...DEFAULT_ENGINE_CONFIG.planByTf[tf as Timeframe], ...(partial.planByTf?.[tf as Timeframe] ?? {}) } as PipPlan,
      ]),
    ),
    thresholds: { ...DEFAULT_ENGINE_CONFIG.thresholds, ...(partial.thresholds ?? {}) },
    biasTfs: { ...DEFAULT_ENGINE_CONFIG.biasTfs, ...(partial.biasTfs ?? {}) },
    expiryBars: { ...DEFAULT_ENGINE_CONFIG.expiryBars, ...(partial.expiryBars ?? {}) },
    minScoreByTf: { ...DEFAULT_ENGINE_CONFIG.minScoreByTf, ...(partial.minScoreByTf ?? {}) },
  };
}

/** Semua TF yang dianalisis: bias (major, minor) + konteks & konfirmasi tiap pasangan. */
export function analysisTfs(cfg: Pick<EngineConfig, "biasTfs" | "pairs"> & Partial<Pick<EngineConfig, "chopRanging">>): Timeframe[] {
  const box = cfg.chopRanging?.tf ? [cfg.chopRanging.tf] : [];
  return [...new Set([cfg.biasTfs.major, cfg.biasTfs.minor, ...cfg.pairs.flatMap((p) => [p.context, p.confirm]), ...box])];
}

/** Rencana SL/TP untuk timeframe konteks tertentu. */
export function planFor(cfg: Pick<EngineConfig, "plan" | "planByTf">, tf: Timeframe): PipPlan {
  return cfg.planByTf?.[tf] ?? cfg.plan;
}

/**
 * Strategi yang sudah dimatikan di sinyal live (engine_state.config.strategies, 20 Okt 2026). Hanya untuk
 * tampilan filter: setup lamanya tetap bisa dicari dengan label "nonaktif". Perbarui bila susunan live berubah.
 */
// 21 Okt 2026: semua strategi yang pernah dinonaktifkan diaktifkan lagi atas permintaan pengguna
export const RETIRED_STRATEGIES: StrategyId[] = [];

/** strategi yang aktif di live sebagai EKSPERIMEN (belum terbukti di backtest) — diberi label di kartu & notifikasi */
export const EXPERIMENTAL_STRATEGIES: StrategyId[] = ["sd_reversal", "liquidity_sweep", "crt", "msnr_flip", "fvg_retest", "order_block", "chop_breakout"];
/** Strategi dua arah penuh: boleh melawan bias utama (tidak ditolak gate struktur & tidak dibatalkan saat bias berlawanan). */
// MSNR flip dikembalikan ke searah tren H1 saja (permintaan pengguna 20 Okt 2026 sore)
// FVG retest sempat dibatasi (20 Okt sore), dibuka lagi dua arah penuh 20 Okt malam atas permintaan pengguna
export const TWO_WAY_STRATEGIES: StrategyId[] = ["fvg_retest"];

export const STRATEGY_LABEL: Record<StrategyId, string> = {
  trend_pullback: "Trend pullback",
  liquidity_sweep: "Liquidity sweep (Eksperimen)",
  sd_reversal: "Supply/Demand reversal (Eksperimen)",
  breakout_retest: "Breakout retest",
  crt: "CRT · Candle Range (Eksperimen)",
  msnr_flip: "MSNR flip (Eksperimen)",
  fvg_retest: "FVG retest (Eksperimen)",
  order_block: "Order Block (Eksperimen)",
  chop_breakout: "Breakout kandang babi (Eksperimen)",
};
