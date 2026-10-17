"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useAnalysis, useNotifications, useSetups, useSnapshot, type AnalysisRow, type ChannelState, type NotificationRow, type SetupRow, type Snapshot } from "@/lib/market";

interface MarketCtx {
  snapshot: Snapshot | null;
  channel: ChannelState;
  analysis: AnalysisRow | null;
  setups: SetupRow[];
  notifications: NotificationRow[];
  refreshSetups: () => Promise<void>;
  loaded: boolean;
}

const Ctx = createContext<MarketCtx>({ snapshot: null, channel: "connecting", analysis: null, setups: [], notifications: [], refreshSetups: async () => {}, loaded: false });

/** Satu langganan realtime per tab untuk seluruh halaman. */
export function MarketProvider({ children }: { children: ReactNode }) {
  const snap = useSnapshot();
  const analysis = useAnalysis();
  const setups = useSetups();
  const notifs = useNotifications();
  return (
    <Ctx.Provider
      value={{
        snapshot: snap.data ?? null,
        channel: snap.channel,
        analysis: analysis.data ?? null,
        setups: setups.data ?? [],
        notifications: notifs.data ?? [],
        refreshSetups: setups.refresh,
        loaded: snap.data !== null || snap.error !== null,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export const useMarket = () => useContext(Ctx);
