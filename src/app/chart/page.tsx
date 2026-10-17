"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { AppShell } from "@/components/Shell";
import { useMarket } from "@/components/MarketContext";
import { Card, Disclaimer, DirBadge, cx, fmt } from "@/components/ui";
import { fetchCandles, type SetupRow } from "@/lib/market";
import { atr, ema, rsi } from "@/core/indicators";
import { TF_SECONDS, TIMEFRAMES, type Candle, type Timeframe } from "@/core/types";
import { STRATEGY_LABEL } from "@/core/config";

export default function Page() {
  return (
    <AppShell>
      <ChartPage />
    </AppShell>
  );
}

const C = { buy: "#22c58b", sell: "#f0506e", gold: "#d6b25e", info: "#5aa9ff", muted: "#93a0b8", line: "#243047", ema20: "#5aa9ff", ema50: "#d6b25e", ema200: "#b36bff" };

type Toggles = { ema20: boolean; ema50: boolean; ema200: boolean; rsi: boolean; atr: boolean; sr: boolean; setup: boolean };

function ChartPage() {
  const { snapshot, setups, analysis } = useMarket();
  const [tf, setTf] = useState<Timeframe>("M15");
  const [tab, setTab] = useState<"engine" | "tradingview">("engine");
  const [setupId, setSetupId] = useState<string>("");
  const [toggles, setToggles] = useState<Toggles>({ ema20: true, ema50: true, ema200: true, rsi: true, atr: true, sr: true, setup: true });
  const [candles, setCandles] = useState<Candle[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const t = q.get("tf") as Timeframe | null;
    if (t && TIMEFRAMES.includes(t)) setTf(t);
    const s = q.get("setup");
    if (s) setSetupId(s);
  }, []);

  useEffect(() => {
    if (!snapshot?.source) return;
    let alive = true;
    const load = () =>
      fetchCandles(snapshot.source, tf, 600)
        .then((c) => {
          if (alive) {
            setCandles(c);
            setErr(null);
          }
        })
        .catch((e) => alive && setErr((e as Error).message));
    void load();
    const t = setInterval(load, Math.max(30, Math.min(TF_SECONDS[tf], 120)) * 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [snapshot?.source, tf]);

  const activeSetups = setups.filter((s) => ["approaching", "awaiting_confirmation", "entry_touched"].includes(s.status));
  const setup = setups.find((s) => s.id === setupId) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-bold">Chart & Analysis</h1>
        <div className="flex rounded-xl border border-line p-0.5 text-sm">
          <button className={cx("rounded-lg px-3 py-1.5", tab === "engine" ? "bg-gold/15 text-gold" : "text-muted")} onClick={() => setTab("engine")}>
            Chart data analisis
          </button>
          <button className={cx("rounded-lg px-3 py-1.5", tab === "tradingview" ? "bg-gold/15 text-gold" : "text-muted")} onClick={() => setTab("tradingview")}>
            Widget TradingView
          </button>
        </div>
      </div>

      {tab === "engine" ? (
        <>
          <Card>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex flex-wrap gap-1" role="group" aria-label="Timeframe">
                {TIMEFRAMES.map((t) => (
                  <button key={t} onClick={() => setTf(t)} className={cx("rounded-lg border px-2.5 py-1 text-xs font-semibold", tf === t ? "border-gold bg-gold/15 text-gold" : "border-line text-muted hover:text-ink")}>
                    {t}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                {(Object.keys(toggles) as (keyof Toggles)[]).map((k) => (
                  <label key={k} className="flex items-center gap-1 text-muted">
                    <input type="checkbox" className="accent-[#d6b25e]" checked={toggles[k]} onChange={(e) => setToggles({ ...toggles, [k]: e.target.checked })} />
                    {{ ema20: "EMA 20", ema50: "EMA 50", ema200: "EMA 200", rsi: "RSI 14", atr: "ATR 14", sr: "S/R", setup: "Level setup" }[k]}
                  </label>
                ))}
              </div>
              <select className="input ml-auto w-full sm:w-72" value={setupId} onChange={(e) => setSetupId(e.target.value)} aria-label="Pilih setup">
                <option value="">— Tanpa setup —</option>
                {(setup && !activeSetups.includes(setup) ? [setup, ...activeSetups] : activeSetups).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.direction} {s.timeframe} {STRATEGY_LABEL[s.strategy]} @ {fmt(s.entry_price)}
                  </option>
                ))}
              </select>
            </div>
            <div className="mt-3">
              {err && <p className="text-sm text-sell">Gagal memuat candle: {err}</p>}
              {candles.length === 0 && !err ? (
                <p className="py-20 text-center text-sm text-muted">Memuat candle {tf}… (data dikumpulkan engine dari provider)</p>
              ) : (
                <LwChart candles={candles} tf={tf} toggles={toggles} setup={toggles.setup ? setup : null} levels={toggles.sr ? (analysis?.levels ?? []) : []} livePrice={snapshot?.price ?? null} />
              )}
            </div>
            <p className="mt-2 text-[11px] text-muted">
              Sumber: {snapshot?.source_label ?? "—"}. Indikator dihitung dari data OHLC yang sama dengan engine analisis. Bar terakhir dapat masih berjalan; sinyal hanya dikonfirmasi oleh candle tertutup.
            </p>
          </Card>
          {setup && <SetupLegend s={setup} />}
        </>
      ) : (
        <Card>
          <TradingViewWidget />
          <p className="mt-2 text-xs text-warn">
            Widget TradingView hanya untuk tampilan tambahan dengan feed miliknya sendiri (mis. OANDA:XAUUSD). Analisis & sinyal GOLDMARKET TIDAK membaca widget ini; harga dapat berbeda dari sumber analisis ({snapshot?.source_label ?? "—"}), terutama bila sumber adalah proxy.
          </p>
        </Card>
      )}
      <Disclaimer />
    </div>
  );
}

function SetupLegend({ s }: { s: SetupRow }) {
  return (
    <Card title="Level setup terpilih">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <DirBadge dir={s.direction} />
        <span>
          Area entry <span className="num text-gold">{fmt(s.entry_low)}–{fmt(s.entry_high)}</span>
        </span>
        <span>
          Entry <span className="num">{fmt(s.entry_price)}</span>
        </span>
        <span>
          SL <span className="num text-sell">{fmt(s.sl)}</span>
        </span>
        <span>
          TP1/2/3 <span className="num text-buy">{fmt(s.tp1)} / {fmt(s.tp2)} / {fmt(s.tp3)}</span>
        </span>
        <span>
          Invalidasi <span className="num">{fmt(s.invalidation)}</span>
        </span>
      </div>
    </Card>
  );
}

function LwChart({
  candles,
  tf,
  toggles,
  setup,
  levels,
  livePrice,
}: {
  candles: Candle[];
  tf: Timeframe;
  toggles: Toggles;
  setup: SetupRow | null;
  levels: { price: number; touches: number; kind: string; tf: string }[];
  livePrice: number | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<{ candle?: ISeriesApi<"Candlestick">; lines: Partial<Record<"e20" | "e50" | "e200" | "r" | "a", ISeriesApi<"Line">>> }>({ lines: {} });
  const ind = useMemo(() => {
    const closes = candles.map((c) => c.close);
    return { e20: ema(closes, 20), e50: ema(closes, 50), e200: ema(closes, 200), r: rsi(closes, 14), a: atr(candles, 14) };
  }, [candles]);
  const dataRef = useRef({ candles, ind });
  dataRef.current = { candles, ind };
  const levelsKey = levels.map((l) => `${l.kind}${l.price.toFixed(2)}`).join("|");

  const applyData = () => {
    const { candle, lines } = seriesRef.current;
    const { candles: cs, ind: ix } = dataRef.current;
    if (!candle) return;
    candle.setData(cs.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })));
    for (const [k, series] of Object.entries(lines)) {
      const vals = ix[k as keyof typeof ix];
      series!.setData(vals.map((v, i) => (Number.isFinite(v) ? { time: cs[i].time as UTCTimestamp, value: v } : null)).filter(Boolean) as { time: UTCTimestamp; value: number }[]);
    }
  };

  // Chart dibuat ulang hanya saat TF/toggle/setup/level berubah; pembaruan data tidak mereset zoom & pan.
  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "#111723" }, textColor: C.muted, fontFamily: "Inter, sans-serif", panes: { separatorColor: C.line } },
      grid: { vertLines: { color: "#1a2333" }, horzLines: { color: "#1a2333" } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: C.line },
      timeScale: { borderColor: C.line, timeVisible: true, secondsVisible: false },
      localization: { locale: "id-ID" },
    });
    chartRef.current = chart;
    const candle = chart.addSeries(CandlestickSeries, { upColor: C.buy, downColor: C.sell, wickUpColor: C.buy, wickDownColor: C.sell, borderVisible: false });
    const lines: typeof seriesRef.current.lines = {};
    const line = (key: keyof typeof lines, color: string, pane = 0, title = "") => {
      lines[key] = chart.addSeries(LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: true, title }, pane);
      return lines[key]!;
    };
    if (toggles.ema20) line("e20", C.ema20, 0, "EMA20");
    if (toggles.ema50) line("e50", C.ema50, 0, "EMA50");
    if (toggles.ema200) line("e200", C.ema200, 0, "EMA200");
    let pane = 1;
    if (toggles.rsi) {
      const r = line("r", C.info, pane, "RSI14");
      r.createPriceLine({ price: 70, color: C.line, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: "" });
      r.createPriceLine({ price: 30, color: C.line, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: "" });
      pane++;
    }
    if (toggles.atr) {
      line("a", C.gold, pane, "ATR14");
      pane++;
    }
    seriesRef.current = { candle, lines };
    applyData();
    const panes = chart.panes();
    for (let i = 1; i < panes.length; i++) panes[i].setHeight(90);

    const pl = (price: number | null | undefined, color: string, title: string, style = LineStyle.Solid) => {
      if (price == null || !Number.isFinite(price)) return;
      candle.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title });
    };
    for (const l of levels) pl(l.price, l.kind === "support" ? "#2f8f6b" : "#a8475a", `${l.kind === "support" ? "S" : "R"} ${l.tf} (${l.touches}×)`, LineStyle.Dotted);
    if (setup) {
      pl(setup.entry_high, C.gold, "Area entry ▲", LineStyle.Dashed);
      pl(setup.entry_low, C.gold, "Area entry ▼", LineStyle.Dashed);
      pl(setup.entry_price, C.gold, `Entry ${setup.entry_type}`);
      pl(setup.sl, C.sell, "SL");
      pl(setup.tp1, C.buy, "TP1");
      pl(setup.tp2, C.buy, "TP2");
      pl(setup.tp3, C.buy, "TP3");
      if (setup.invalidation != null) pl(setup.invalidation, C.muted, "Invalidasi", LineStyle.SparseDotted);
    }
    const n = dataRef.current.candles.length;
    if (n > 150) chart.timeScale().setVisibleLogicalRange({ from: n - 150, to: n + 5 });
    else chart.timeScale().fitContent();
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = { lines: {} };
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tf, toggles, setup?.id, levelsKey]);

  useEffect(() => {
    applyData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, ind]);

  // bar berjalan mengikuti harga live (hanya tampilan; analisis tetap memakai candle tertutup)
  useEffect(() => {
    const s = seriesRef.current.candle;
    const last = candles[candles.length - 1];
    if (!s || !last || livePrice == null) return;
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec >= last.time + TF_SECONDS[tf]) return;
    s.update({ time: last.time as UTCTimestamp, open: last.open, high: Math.max(last.high, livePrice), low: Math.min(last.low, livePrice), close: livePrice });
  }, [livePrice, candles, tf]);

  return <div ref={ref} className="h-[520px] w-full sm:h-[620px]" />;
}

function TradingViewWidget() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    ref.current.innerHTML = '<div class="tradingview-widget-container__widget" style="height:100%;width:100%"></div>';
    const s = document.createElement("script");
    s.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    s.async = true;
    s.innerHTML = JSON.stringify({
      autosize: true,
      symbol: "OANDA:XAUUSD",
      interval: "15",
      timezone: "Asia/Jakarta",
      theme: "dark",
      style: "1",
      locale: "id",
      allow_symbol_change: false,
      hide_side_toolbar: false,
      studies: ["STD;EMA", "STD;RSI"],
      support_host: "https://www.tradingview.com",
    });
    ref.current.appendChild(s);
  }, []);
  return <div ref={ref} className="tradingview-widget-container h-[520px] w-full sm:h-[620px]" />;
}
