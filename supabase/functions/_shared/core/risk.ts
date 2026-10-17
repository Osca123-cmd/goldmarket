import type { Direction } from "./types.ts";
import { priceToPips, roundTo, type InstrumentSpec } from "./instrument.ts";

export interface BrokerSpec extends InstrumentSpec {
  lotStep: number;
  minLot: number;
  maxLot: number;
  /** komisi round-turn per lot, dalam mata uang akun */
  commissionPerLot: number;
}

export const DEFAULT_BROKER: BrokerSpec = {
  symbol: "XAUUSD",
  pipSize: 0.1,
  tickSize: 0.01,
  digits: 2,
  contractSize: 100,
  quoteCurrency: "USD",
  lotStep: 0.01,
  minLot: 0.01,
  maxLot: 100,
  commissionPerLot: 0,
};

export interface RiskInput {
  direction: Direction;
  balance: number;
  accountCurrency: string;
  riskPercent: number;
  entry: number;
  sl: number;
  tps: number[];
  spreadPips: number;
  broker: BrokerSpec;
  /**
   * Kurs: 1 unit mata uang kuotasi (USD) = `quoteToAccountRate` unit mata uang akun.
   * Akun USD → 1. Akun IDR → mis. 16250 (masukkan kurs aktual broker).
   */
  quoteToAccountRate: number;
}

export interface TpResult {
  price: number;
  pips: number;
  profit: number;
  profitAfterCost: number;
  rr: number;
  rrAfterCost: number;
}

export interface RiskResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  riskAmount: number;
  slPips: number;
  /** nilai 1 pip untuk 1 lot dalam mata uang akun = pipSize × contractSize × kurs */
  pipValuePerLot: number;
  rawLot: number;
  lot: number;
  actualRisk: number;
  costPerTrade: number;
  actualRiskWithCost: number;
  tps: TpResult[];
}

/** Bulatkan ke BAWAH ke kelipatan lot step agar risiko tidak melampaui batas. */
export function floorToStep(value: number, step: number): number {
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)) + 2);
  const n = Math.floor(roundTo(value / step, 8));
  return roundTo(n * step, decimals);
}

export function calculateRisk(i: RiskInput): RiskResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const b = i.broker;
  if (!(i.balance > 0)) errors.push("Saldo harus lebih dari 0.");
  if (!(i.riskPercent > 0 && i.riskPercent <= 100)) errors.push("Risiko % harus di antara 0 dan 100.");
  if (!(i.entry > 0) || !(i.sl > 0)) errors.push("Entry dan SL harus diisi.");
  if (!(i.quoteToAccountRate > 0)) errors.push("Kurs konversi harus lebih dari 0.");
  if (!(b.pipSize > 0 && b.contractSize > 0 && b.lotStep > 0)) errors.push("Spesifikasi broker tidak valid.");
  const s = i.direction === "BUY" ? 1 : -1;
  if (i.entry > 0 && i.sl > 0 && s * (i.entry - i.sl) <= 0) errors.push(`SL harus ${i.direction === "BUY" ? "di bawah" : "di atas"} entry untuk ${i.direction}.`);
  i.tps.forEach((tp, k) => {
    if (tp > 0 && s * (tp - i.entry) <= 0) errors.push(`TP${k + 1} harus ${i.direction === "BUY" ? "di atas" : "di bawah"} entry.`);
  });

  const empty: RiskResult = { ok: false, errors, warnings, riskAmount: 0, slPips: 0, pipValuePerLot: 0, rawLot: 0, lot: 0, actualRisk: 0, costPerTrade: 0, actualRiskWithCost: 0, tps: [] };
  if (errors.length) return empty;

  const riskAmount = (i.balance * i.riskPercent) / 100;
  const slPips = priceToPips(Math.abs(i.entry - i.sl), b);
  const pipValuePerLot = b.pipSize * b.contractSize * i.quoteToAccountRate;
  const spreadCostPerLot = i.spreadPips * pipValuePerLot;
  const costPerLot = spreadCostPerLot + b.commissionPerLot;
  // lot sehingga risiko SL + biaya <= riskAmount
  const rawLot = riskAmount / (slPips * pipValuePerLot + costPerLot);
  let lot = Math.min(floorToStep(rawLot, b.lotStep), b.maxLot);
  if (lot < b.minLot) {
    warnings.push(`Lot hasil perhitungan (${rawLot.toFixed(4)}) di bawah lot minimum ${b.minLot}. Lot minimum akan melampaui batas risiko — pertimbangkan tidak mengambil posisi.`);
    lot = 0;
  }
  if (rawLot > b.maxLot) warnings.push(`Lot dibatasi lot maksimum broker ${b.maxLot}.`);
  const actualRisk = slPips * pipValuePerLot * lot;
  const costPerTrade = costPerLot * lot;
  const tps: TpResult[] = i.tps
    .filter((tp) => tp > 0)
    .map((tp) => {
      const pips = priceToPips(Math.abs(tp - i.entry), b);
      const profit = pips * pipValuePerLot * lot;
      return {
        price: tp,
        pips,
        profit,
        profitAfterCost: profit - costPerTrade,
        rr: pips / slPips,
        rrAfterCost: lot > 0 ? (profit - costPerTrade) / (actualRisk + costPerTrade) : (pips - i.spreadPips) / (slPips + i.spreadPips),
      };
    });
  return {
    ok: true,
    errors,
    warnings,
    riskAmount,
    slPips,
    pipValuePerLot,
    rawLot,
    lot,
    actualRisk,
    costPerTrade,
    actualRiskWithCost: actualRisk + costPerTrade,
    tps,
  };
}

/** Nilai uang (mata uang akun) dari pergerakan harga untuk lot tertentu. */
export function pnlForMove(
  direction: Direction,
  entry: number,
  exit: number,
  lot: number,
  contractSize: number,
  quoteToAccountRate = 1,
): number {
  const s = direction === "BUY" ? 1 : -1;
  return s * (exit - entry) * contractSize * lot * quoteToAccountRate;
}
