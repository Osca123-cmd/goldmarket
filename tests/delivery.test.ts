import { describe, expect, it } from "vitest";
import { deliveryBlock } from "../src/core/delivery.ts";
import type { StoredSetup } from "../src/core/setups.ts";
import type { DeliveryRules } from "../src/core/config.ts";

const WIB = (h: number, m = 0, day = 0) => Date.UTC(2026, 9, 20 + day, h - 7, m) / 1000;
const rules: DeliveryRules = {
  oneAtATime: true,
  windows: [{ label: "14.00–17.00 WIB", startHour: 14, endHour: 17, utcOffsetHours: 7, entryTypes: ["stop", "market"], maxPerDay: 1 }],
};
const cfg = { delivery: rules };
const setup = (o: Partial<StoredSetup>): StoredSetup => ({
  id: "a", identity_key: "a", strategy: "sd_reversal", direction: "BUY", timeframe: "M30", confirm_tf: "M15", entry_type: "limit",
  entry_price: 4172.15, entry_low: 4168.54, entry_high: 4172.15, invalidation: 4165.96, sl: 4165.15,
  created_at_sec: WIB(10), expires_at_sec: WIB(12), status: "approaching", eligible: true, confirmed_at_sec: null, entry_touched_at_sec: null,
  outcome: null, outcome_tp: null, ...o,
});

describe("aturan pengiriman sinyal", () => {
  it("READY layak yang belum kena entry menahan sinyal baru", () => {
    expect(deliveryBlock({ entryType: "limit" }, [setup({})], cfg, WIB(11))).toMatch(/Menunggu sinyal BUY M30 4172.15/);
  });
  it("sinyal berjalan menahan sampai TP1; setelah TP1 (SL di BE) boleh", () => {
    expect(deliveryBlock({ entryType: "limit" }, [setup({ status: "entry_touched", outcome: "open", outcome_tp: 0 })], cfg, WIB(11))).not.toBeNull();
    expect(deliveryBlock({ entryType: "limit" }, [setup({ status: "entry_touched", outcome: "open", outcome_tp: 1 })], cfg, WIB(11))).toBeNull();
  });
  it("sinyal selesai, invalid, kedaluwarsa, atau tidak layak tidak menahan", () => {
    for (const o of [{ status: "entry_touched" as const, outcome: "loss" }, { status: "invalid" as const }, { status: "expired" as const }, { eligible: false }]) {
      expect(deliveryBlock({ entryType: "limit" }, [setup(o)], cfg, WIB(11))).toBeNull();
    }
  });
  it("jam 14.00–17.00 WIB: limit ditahan, stop/market boleh", () => {
    expect(deliveryBlock({ entryType: "limit" }, [], cfg, WIB(15))).toMatch(/hanya entry stop\/market/);
    expect(deliveryBlock({ entryType: "stop" }, [], cfg, WIB(15))).toBeNull();
    expect(deliveryBlock({ entryType: "market" }, [], cfg, WIB(15))).toBeNull();
  });
  it("jam 14.00–17.00 WIB: maks 1 sinyal per hari; besok boleh lagi", () => {
    const sentToday = setup({ entry_type: "stop", created_at_sec: WIB(14, 30), status: "invalid" });
    expect(deliveryBlock({ entryType: "stop" }, [sentToday], cfg, WIB(16))).toMatch(/maks 1 sinyal/);
    expect(deliveryBlock({ entryType: "stop" }, [sentToday], cfg, WIB(15, 0, 1))).toBeNull();
    // sinyal tidak layak tidak dihitung
    expect(deliveryBlock({ entryType: "stop" }, [{ ...sentToday, eligible: false }], cfg, WIB(16))).toBeNull();
  });
  it("13.59 dan 17.00 WIB di luar jendela", () => {
    expect(deliveryBlock({ entryType: "limit" }, [], cfg, WIB(13, 59))).toBeNull();
    expect(deliveryBlock({ entryType: "limit" }, [], cfg, WIB(17))).toBeNull();
  });
  it("tanpa aturan → tidak pernah menahan", () => {
    expect(deliveryBlock({ entryType: "limit" }, [setup({})], {}, WIB(15))).toBeNull();
  });
});
