import { describe, expect, it } from "vitest";
import { calculateRisk, DEFAULT_BROKER, floorToStep } from "../src/core/risk.ts";

const base = {
  direction: "BUY" as const,
  balance: 10_000,
  accountCurrency: "USD",
  riskPercent: 1,
  entry: 3000,
  sl: 2995,
  tps: [3005, 3010, 3015],
  spreadPips: 0,
  broker: DEFAULT_BROKER,
  quoteToAccountRate: 1,
};

describe("kalkulator risiko", () => {
  it("lot = risiko / (pips SL × nilai pip per lot)", () => {
    const r = calculateRisk(base);
    expect(r.ok).toBe(true);
    expect(r.riskAmount).toBe(100);
    expect(r.slPips).toBe(50);
    expect(r.pipValuePerLot).toBe(10); // 0.1 × 100 oz
    expect(r.lot).toBe(0.2);
    expect(r.actualRisk).toBeCloseTo(100);
    expect(r.tps.map((t) => t.profit)).toEqual([100, 200, 300].map((x) => expect.closeTo(x, 6)));
  });

  it("lot dibulatkan ke BAWAH sesuai lot step sehingga risiko ≤ batas", () => {
    const r = calculateRisk({ ...base, balance: 1234 }); // 12.34 / 500 = 0.02468
    expect(r.lot).toBe(0.02);
    expect(r.actualRisk).toBeLessThanOrEqual(r.riskAmount);
    expect(floorToStep(0.0299999, 0.01)).toBe(0.02);
    expect(floorToStep(0.03, 0.01)).toBe(0.03);
    expect(floorToStep(1.27, 0.1)).toBe(1.2);
  });

  it("konversi mata uang akun (IDR) memakai kurs, bukan nilai pip hardcode", () => {
    const r = calculateRisk({ ...base, balance: 100_000_000, accountCurrency: "IDR", quoteToAccountRate: 16_000 });
    expect(r.pipValuePerLot).toBe(160_000);
    expect(r.lot).toBe(0.12); // 1.000.000 / (50 × 160.000) = 0.125 → 0.12
    expect(r.actualRisk).toBeLessThanOrEqual(1_000_000);
  });

  it("biaya (spread + komisi) ikut dihitung dan RR setelah biaya lebih kecil", () => {
    const r = calculateRisk({ ...base, spreadPips: 3, broker: { ...DEFAULT_BROKER, commissionPerLot: 7 } });
    expect(r.actualRiskWithCost).toBeLessThanOrEqual(r.riskAmount + 1e-9);
    expect(r.tps[0].rrAfterCost).toBeLessThan(r.tps[0].rr);
  });

  it("menolak SL di sisi yang salah dan memberi peringatan lot di bawah minimum", () => {
    expect(calculateRisk({ ...base, sl: 3005 }).ok).toBe(false);
    const tiny = calculateRisk({ ...base, balance: 10 });
    expect(tiny.lot).toBe(0);
    expect(tiny.warnings[0]).toMatch(/lot minimum/);
  });

  it("SELL: SL di atas entry", () => {
    const r = calculateRisk({ ...base, direction: "SELL", sl: 3005, tps: [2995] });
    expect(r.ok).toBe(true);
    expect(r.lot).toBe(0.2);
  });
});
