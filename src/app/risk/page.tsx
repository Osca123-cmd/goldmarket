"use client";

import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/Shell";
import { useMarket } from "@/components/MarketContext";
import { Card, Disclaimer, Field, Stat, cx, fmt, fmtMoney } from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { isActiveSignal } from "@/lib/market";
import { calculateRisk, type BrokerSpec } from "@/core/risk";
import { levelsFromEntry } from "@/core/instrument";
import type { Direction } from "@/core/types";

export default function Page() {
  return (
    <AppShell>
      <RiskCalc />
    </AppShell>
  );
}

function num(v: string): number {
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
}

function RiskCalc() {
  const { settings } = useAuth();
  const { snapshot, setups } = useMarket();
  const [dir, setDir] = useState<Direction>("BUY");
  const [f, setF] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!settings || Object.keys(f).length) return;
    setF({
      balance: String(settings.account_balance),
      currency: settings.account_currency,
      risk: String(settings.risk_percent),
      rate: String(settings.quote_to_account_rate),
      entry: snapshot?.price ? snapshot.price.toFixed(2) : "",
      sl: "",
      tp1: "",
      tp2: "",
      tp3: "",
      spread: String(settings.default_spread_pips),
      pip: String(settings.pip_size),
      tick: String(settings.tick_size),
      digits: String(settings.digits),
      contract: String(settings.contract_size),
      step: String(settings.lot_step),
      min: String(settings.min_lot),
      max: String(settings.max_lot),
      commission: String(settings.commission_per_lot),
    });
  }, [settings, snapshot?.price, f]);

  const broker: BrokerSpec = {
    symbol: "XAUUSD",
    quoteCurrency: "USD",
    pipSize: num(f.pip),
    tickSize: num(f.tick),
    digits: Math.max(0, Math.round(num(f.digits))),
    contractSize: num(f.contract),
    lotStep: num(f.step),
    minLot: num(f.min),
    maxLot: num(f.max),
    commissionPerLot: num(f.commission),
  };

  const fillDefaults = () => {
    if (!settings) return;
    const e = num(f.entry);
    if (!(e > 0)) return;
    const lv = levelsFromEntry(dir, e, { slPips: settings.sl_pips, tp1Pips: settings.tp1_pips, tp2Pips: settings.tp2_pips, tp3Pips: settings.tp3_pips }, broker);
    setF({ ...f, sl: lv.sl.toFixed(broker.digits), tp1: lv.tp1.toFixed(broker.digits), tp2: lv.tp2.toFixed(broker.digits), tp3: lv.tp3.toFixed(broker.digits) });
  };

  const fromSetup = (id: string) => {
    const s = setups.find((x) => x.id === id);
    if (!s) return;
    setDir(s.direction);
    setF({ ...f, entry: String(s.entry_price), sl: String(s.sl), tp1: String(s.tp1), tp2: String(s.tp2), tp3: String(s.tp3) });
  };

  const res = useMemo(
    () =>
      calculateRisk({
        direction: dir,
        balance: num(f.balance),
        accountCurrency: f.currency ?? "USD",
        riskPercent: num(f.risk),
        entry: num(f.entry),
        sl: num(f.sl),
        tps: [num(f.tp1), num(f.tp2), num(f.tp3)].filter((x) => x > 0),
        spreadPips: num(f.spread) || 0,
        broker,
        quoteToAccountRate: num(f.rate),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [f, dir],
  );
  const ccy = /^[A-Z]{3}$/.test(f.currency ?? "") ? f.currency : "USD";
  const inp = (k: string, label: string, hint?: string, mode: "decimal" | "text" = "decimal") => (
    <Field label={label} hint={hint}>
      <input className="input num" inputMode={mode} value={f[k] ?? ""} onChange={(e) => setF({ ...f, [k]: mode === "text" ? e.target.value.toUpperCase().slice(0, 3) : e.target.value })} />
    </Field>
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">Kalkulator Risiko</h1>
        <p className="text-sm text-muted">Hitung ukuran lot dari risiko nominal. Spesifikasi broker dapat diubah; nilai pip per lot tidak di-hardcode.</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3" title="Input">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <button className={cx(dir === "BUY" ? "btn-buy" : "btn-ghost")} onClick={() => setDir("BUY")}>
              BUY
            </button>
            <button className={cx(dir === "SELL" ? "btn-sell" : "btn-ghost")} onClick={() => setDir("SELL")}>
              SELL
            </button>
            <select className="input ml-auto w-full sm:w-64" defaultValue="" onChange={(e) => fromSetup(e.target.value)} aria-label="Isi dari setup">
              <option value="">Isi dari setup aktif…</option>
              {setups
                .filter((s) => s.eligible && isActiveSignal(s))
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.direction} {s.timeframe} @ {fmt(s.entry_price)}
                  </option>
                ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {inp("balance", "Saldo akun")}
            {inp("currency", "Mata uang akun", "Kode ISO, mis. USD/IDR", "text")}
            {inp("risk", "Risiko (%)")}
            {inp("rate", "Kurs USD → akun", "1 USD = ? mata uang akun")}
            {inp("entry", "Entry")}
            {inp("sl", "Stop loss")}
            {inp("spread", "Spread (pips)")}
            <div className="flex items-end">
              <button className="btn-ghost w-full text-xs" onClick={fillDefaults} title="Isi SL/TP dari pengaturan pips Anda">
                Isi SL/TP default
              </button>
            </div>
            {inp("tp1", "TP1")}
            {inp("tp2", "TP2")}
            {inp("tp3", "TP3")}
          </div>
          <details className="mt-4 rounded-xl border border-line p-3">
            <summary className="cursor-pointer text-sm font-semibold">Spesifikasi broker</summary>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {inp("pip", "Pip size", "Default 0.10")}
              {inp("tick", "Tick size")}
              {inp("digits", "Desimal")}
              {inp("contract", "Contract size (oz/lot)")}
              {inp("step", "Lot step")}
              {inp("min", "Lot minimum")}
              {inp("max", "Lot maksimum")}
              {inp("commission", "Komisi / lot (round-turn, mata uang akun)")}
            </div>
          </details>
        </Card>
        <Card className="lg:col-span-2" title="Hasil">
          {!res.ok ? (
            <ul className="space-y-1 text-sm text-sell">
              {res.errors.map((e, i) => (
                <li key={i}>• {e}</li>
              ))}
            </ul>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <Stat label="Risiko nominal" value={fmtMoney(res.riskAmount, ccy)} />
                <Stat label="Jarak SL" value={`${fmt(res.slPips, 1)} pips`} />
                <Stat label="Estimasi lot" value={fmt(res.lot, 2)} tone="gold" sub={`mentah ${res.rawLot.toFixed(4)} → dibulatkan ke bawah`} />
                <Stat label="Nilai 1 pip / lot" value={fmtMoney(res.pipValuePerLot, ccy)} />
                <Stat label="Risiko aktual (SL)" value={fmtMoney(res.actualRisk, ccy)} />
                <Stat label="Biaya (spread+komisi)" value={fmtMoney(res.costPerTrade, ccy)} sub={`Total risiko ${fmtMoney(res.actualRiskWithCost, ccy)}`} />
              </div>
              {res.warnings.map((w, i) => (
                <p key={i} className="rounded-lg border border-warn/40 p-2 text-xs text-warn">
                  {w}
                </p>
              ))}
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Target</th>
                      <th>Pips</th>
                      <th>Profit</th>
                      <th>Setelah biaya</th>
                      <th>RR</th>
                      <th>RR net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {res.tps.map((t, i) => (
                      <tr key={i}>
                        <td>TP{i + 1} <span className="num text-muted">{fmt(t.price)}</span></td>
                        <td className="num">{fmt(t.pips, 1)}</td>
                        <td className="num text-buy">{fmtMoney(t.profit, ccy)}</td>
                        <td className="num">{fmtMoney(t.profitAfterCost, ccy)}</td>
                        <td className="num">{fmt(t.rr)}</td>
                        <td className="num">{fmt(t.rrAfterCost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-muted">
                Lot = risiko ÷ (pips SL × nilai pip per lot + biaya per lot), dibulatkan ke bawah sesuai lot step agar risiko tidak melampaui batas. Nilai pip per lot = pip size × contract size × kurs. Kalkulator tidak membuka order.
              </p>
            </div>
          )}
        </Card>
      </div>
      <Disclaimer />
    </div>
  );
}
