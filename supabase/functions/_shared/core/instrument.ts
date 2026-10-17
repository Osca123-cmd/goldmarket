import type { Direction } from "./types.ts";

/**
 * Spesifikasi instrumen. Pip size, tick size, jumlah desimal, dan contract
 * size sengaja dipisah karena berbeda antar broker.
 *
 * Default aplikasi XAUUSD:
 *  - 1 pip     = 0.10 USD per troy ounce
 *  - tick size = 0.01
 *  - desimal   = 2
 *  - 1 lot     = 100 troy ounce
 */
export interface InstrumentSpec {
  symbol: string;
  pipSize: number;
  tickSize: number;
  digits: number;
  contractSize: number;
  quoteCurrency: string;
}

export const DEFAULT_XAUUSD: InstrumentSpec = {
  symbol: "XAUUSD",
  pipSize: 0.1,
  tickSize: 0.01,
  digits: 2,
  contractSize: 100,
  quoteCurrency: "USD",
};

export interface PipPlan {
  slPips: number;
  tp1Pips: number;
  tp2Pips: number;
  tp3Pips: number;
}

export const DEFAULT_PIP_PLAN: PipPlan = { slPips: 50, tp1Pips: 50, tp2Pips: 100, tp3Pips: 150 };

export function roundTo(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round((value + Number.EPSILON * Math.sign(value)) * f) / f;
}

/** Bulatkan harga ke kelipatan tick terdekat. */
export function roundToTick(price: number, spec: InstrumentSpec): number {
  const ticks = Math.round(price / spec.tickSize);
  return roundTo(ticks * spec.tickSize, spec.digits);
}

export function pipsToPrice(pips: number, spec: InstrumentSpec): number {
  return roundTo(pips * spec.pipSize, spec.digits + 2);
}

export function priceToPips(priceDistance: number, spec: InstrumentSpec): number {
  return roundTo(priceDistance / spec.pipSize, 1);
}

export function directionSign(direction: Direction): 1 | -1 {
  return direction === "BUY" ? 1 : -1;
}

export interface TradeLevels {
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
}

/**
 * Hitung SL/TP dari harga entry.
 * BUY: SL di bawah entry, TP di atas. SELL: sebaliknya.
 * Contoh default BUY 3000.00 → SL 2995.00, TP1 3005.00, TP2 3010.00, TP3 3015.00.
 */
export function levelsFromEntry(
  direction: Direction,
  entry: number,
  plan: PipPlan,
  spec: InstrumentSpec,
): TradeLevels {
  const s = directionSign(direction);
  const at = (pips: number) => roundToTick(entry + s * pipsToPrice(pips, spec), spec);
  return {
    entry: roundToTick(entry, spec),
    sl: roundToTick(entry - s * pipsToPrice(plan.slPips, spec), spec),
    tp1: at(plan.tp1Pips),
    tp2: at(plan.tp2Pips),
    tp3: at(plan.tp3Pips),
  };
}

/** Jarak bertanda dalam pips: positif = harga masih harus bergerak searah `direction` untuk mencapai target. */
export function signedPips(from: number, to: number, spec: InstrumentSpec): number {
  return priceToPips(to - from, spec);
}

export function formatPrice(price: number | null | undefined, spec: InstrumentSpec = DEFAULT_XAUUSD): string {
  if (price == null || !Number.isFinite(price)) return "—";
  return price.toLocaleString("id-ID", {
    minimumFractionDigits: spec.digits,
    maximumFractionDigits: spec.digits,
  });
}
