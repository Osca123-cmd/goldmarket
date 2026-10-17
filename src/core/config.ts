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
  plan: PipPlan;
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
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  spec: DEFAULT_XAUUSD,
  plan: DEFAULT_PIP_PLAN,
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
  expiryBars: { trend_pullback: 16, breakout_retest: 12 },
  dedupePips: 30,
  cooldownBars: 2,
  maxDistanceAtr: 1.5,
};

export function mergeConfig(partial: Partial<EngineConfig> | null | undefined): EngineConfig {
  if (!partial) return DEFAULT_ENGINE_CONFIG;
  return {
    ...DEFAULT_ENGINE_CONFIG,
    ...partial,
    spec: { ...DEFAULT_ENGINE_CONFIG.spec, ...(partial.spec ?? {}) },
    plan: { ...DEFAULT_ENGINE_CONFIG.plan, ...(partial.plan ?? {}) },
    thresholds: { ...DEFAULT_ENGINE_CONFIG.thresholds, ...(partial.thresholds ?? {}) },
    expiryBars: { ...DEFAULT_ENGINE_CONFIG.expiryBars, ...(partial.expiryBars ?? {}) },
    minScoreByTf: { ...DEFAULT_ENGINE_CONFIG.minScoreByTf, ...(partial.minScoreByTf ?? {}) },
  };
}

export const STRATEGY_LABEL: Record<StrategyId, string> = {
  trend_pullback: "Trend pullback",
  breakout_retest: "Breakout retest",
};
