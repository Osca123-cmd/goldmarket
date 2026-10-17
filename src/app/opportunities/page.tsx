"use client";

import { useMemo, useState } from "react";
import { AppShell } from "@/components/Shell";
import { useMarket } from "@/components/MarketContext";
import { SetupCard } from "@/components/SetupCard";
import { Card, Disclaimer, Empty, useNow } from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { OPPORTUNITY_STATUS_LABEL } from "@/core/setups";
import { STRATEGY_LABEL } from "@/core/config";
import type { OpportunityStatus } from "@/core/types";

export default function Page() {
  return (
    <AppShell>
      <Opportunities />
    </AppShell>
  );
}

const SESSION_LABEL: Record<string, string> = { asia: "Asia", london: "London", newyork: "New York", off: "Di luar sesi" };

function Opportunities() {
  const { setups, snapshot } = useMarket();
  const { settings } = useAuth();
  const now = useNow(5000);
  const tz = settings?.display_tz ?? "Asia/Jakarta";
  const [f, setF] = useState({ dir: "", tf: "", strategy: "", minScore: "", session: "", status: "active", eligible: "yes" });

  const list = useMemo(
    () =>
      setups.filter((s) => {
        if (f.dir && s.direction !== f.dir) return false;
        if (f.tf && s.timeframe !== f.tf) return false;
        if (f.strategy && s.strategy !== f.strategy) return false;
        const min = f.minScore === "" ? (settings?.min_score?.[s.timeframe] ?? 60) : Number(f.minScore);
        if (s.score < min) return false;
        if (f.session && (s.session ?? "off") !== f.session) return false;
        if (f.status === "active" && !["approaching", "awaiting_confirmation", "entry_touched"].includes(s.status)) return false;
        if (f.status && f.status !== "active" && f.status !== "all" && s.status !== f.status) return false;
        if (f.eligible === "yes" && !s.eligible) return false;
        if (f.eligible === "no" && s.eligible) return false;
        return true;
      }),
    [setups, f, settings],
  );

  const sel = (key: keyof typeof f, label: string, opts: [string, string][]) => (
    <label className="min-w-0">
      <span className="label">{label}</span>
      <select className="input" value={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.value })}>
        {opts.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">Live Opportunities</h1>
        <p className="text-sm text-muted">Peluang dari engine server. Status peluang terpisah dari jurnal — “Entry tersentuh” pada feed tidak berarti Anda membuka posisi.</p>
      </div>
      <Card title="Filter">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          {sel("dir", "Arah", [["", "Semua"], ["BUY", "BUY"], ["SELL", "SELL"]])}
          {sel("tf", "Timeframe", [["", "Semua"], ["M15", "M15"], ["H1", "H1"]])}
          {sel("strategy", "Strategi", [["", "Semua"], ...Object.entries(STRATEGY_LABEL)])}
          {sel("minScore", "Skor minimum", [["", "Sesuai pengaturan"], ["0", "0"], ["40", "40"], ["50", "50"], ["60", "60"], ["70", "70"], ["80", "80"]])}
          {sel("session", "Sesi", [["", "Semua"], ...Object.entries(SESSION_LABEL)])}
          {sel("status", "Status", [["active", "Aktif"], ["all", "Semua"], ...(Object.entries(OPPORTUNITY_STATUS_LABEL) as [OpportunityStatus, string][])])}
          {sel("eligible", "Kelayakan", [["yes", "Layak saja"], ["no", "Tidak layak saja"], ["", "Semua"]])}
        </div>
      </Card>
      <div className="space-y-3">
        {list.length === 0 ? (
          <Empty title="Belum ada setup valid">Tidak ada peluang yang cocok dengan filter. Engine tidak memaksakan jumlah sinyal minimum.</Empty>
        ) : (
          list.map((s) => <SetupCard key={s.id} s={s} price={snapshot?.price ?? null} tz={tz} now={now} minScore={settings?.min_score?.[s.timeframe]} pipSize={settings?.pip_size} />)
        )}
      </div>
      <Disclaimer />
    </div>
  );
}
