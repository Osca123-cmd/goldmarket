import type { StrategyId, Timeframe } from "./types.ts";
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
  pairs: TfPair[];
  strategies: StrategyId[];
  /** skor minimum agar engine menyimpan setup (filter per pengguna bisa lebih ketat) */
  engineMinScore: number;
  /** skor minimum default per timeframe konteks (dipakai notifikasi & filter default) */
  minScoreByTf: Partial<Record<Timeframe, number>>;
  /** RR minimum pada TP2 setelah biaya spread (syarat wajib kelayakan risiko) */
  minRrAfterCost: number;
  /** SL minimum dalam kelipatan ATR timeframe konfirmasi (di bawahnya = noise) */
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
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  spec: DEFAULT_XAUUSD,
  plan: DEFAULT_PIP_PLAN,
  planByTf: {
    M15: DEFAULT_PIP_PLAN,
    H1: { slPips: 100, tp1Pips: 100, tp2Pips: 200, tp3Pips: 300 },
  },
  thresholds: DEFAULT_THRESHOLDS,
  pairs: [
    { context: "M15", confirm: "M5" },
    { context: "H1", confirm: "M15" },
  ],
  strategies: ["trend_pullback", "breakout_retest"],
  engineMinScore: 40,
  minScoreByTf: { M15: 60, H1: 60 },
  minRrAfterCost: 1.5,
  minSlAtrConfirm: 1.0,
  minSlAtrContext: 0.75,
  expiryBars: { trend_pullback: 16, breakout_retest: 12, liquidity_sweep: 8, sd_reversal: 8 },
  dedupePips: 30,
  cooldownBars: 2,
  maxDistanceAtr: 1.5,
  newsBlackoutMin: 30,
  invalidationTolPips: 0,
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
    expiryBars: { ...DEFAULT_ENGINE_CONFIG.expiryBars, ...(partial.expiryBars ?? {}) },
    minScoreByTf: { ...DEFAULT_ENGINE_CONFIG.minScoreByTf, ...(partial.minScoreByTf ?? {}) },
  };
}

/** Rencana SL/TP untuk timeframe konteks tertentu. */
export function planFor(cfg: Pick<EngineConfig, "plan" | "planByTf">, tf: Timeframe): PipPlan {
  return cfg.planByTf?.[tf] ?? cfg.plan;
}

export const STRATEGY_LABEL: Record<StrategyId, string> = {
  trend_pullback: "Trend pullback",
  liquidity_sweep: "Liquidity sweep",
  sd_reversal: "Supply/Demand reversal",
  breakout_retest: "Breakout retest",
};
