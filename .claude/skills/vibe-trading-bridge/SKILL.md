---
name: vibe-trading-bridge
description: Combine the live TradingView chart with the Vibe-Trading MCP server — turn a chart setup into a Vibe-Trading backtest, port a Vibe-Trading strategy to Pine and verify it in the Strategy Tester, or enrich chart analysis with fundamentals and news. Use when the user wants an independent backtest, cross-validation between Vibe-Trading and TradingView, or data TradingView doesn't expose.
---

# TradingView × Vibe-Trading Bridge

You are working with two MCP servers at once:

- **tradingview** ([tradesdontlie/tradingview-mcp](https://github.com/tradesdontlie/tradingview-mcp)) — reads and controls the user's live TradingView Desktop chart.
- **vibe-trading** ([HKUDS/Vibe-Trading](https://github.com/HKUDS/Vibe-Trading)) — market data, a vectorized backtest engine, statistical validation, fundamentals and news. All of its MCP tools are read-only or research-only; it exposes no order-placing tools.

Tool names below are bare. In Claude Code they appear as `mcp__tradingview__<name>` and `mcp__vibe-trading__<name>`.

## Step 0: Check Both Servers

1. `tv_health_check` — TradingView must be connected (run `tv_launch` if not).
2. `list_skills` (vibe-trading) — confirms the Vibe-Trading server is reachable.

If the vibe-trading tools are missing, give the user this setup and stop:

```bash
pip install vibe-trading-ai      # Python 3.11+, provides the vibe-trading-mcp command
claude mcp add vibe-trading -- vibe-trading-mcp
```

If `pip install` fails while building a dependency such as `jsonpath`, the system setuptools is usually too old. Install into a virtualenv instead and register the full path:

```bash
python3 -m venv ~/.vibe-trading-venv
~/.vibe-trading-venv/bin/pip install -U pip setuptools wheel
~/.vibe-trading-venv/bin/pip install vibe-trading-ai
claude mcp add --scope user vibe-trading -- ~/.vibe-trading-venv/bin/vibe-trading-mcp
```

The PyPI release can lag the GitHub source, so some tools mentioned below may be missing. Fallbacks are noted where that matters.

No API keys are needed for US/HK equities (yfinance) or crypto (OKX). China A-shares via Tushare need `TUSHARE_TOKEN` set in the server's `env` block, not a shell export.

Never ask the user to enable `VIBE_TRADING_ENABLE_SHELL_TOOLS` — nothing in this workflow needs it.

## Step 1: Pick the Workflow

| User wants | Workflow |
|---|---|
| "Does the setup on my chart actually work?" / independent backtest | **A: Chart → Backtest** |
| "Put this Vibe-Trading strategy on my chart" / cross-check results | **B: Backtest → Pine → Strategy Tester** |
| "What's the fundamental/news context for this chart?" | **C: Context Enrichment** |

A and B chain naturally: run A, then B to see the same rules on the chart.

## Translation Tables

### Symbols (TradingView → Vibe-Trading code)

| TradingView | Vibe-Trading | Source |
|---|---|---|
| `NASDAQ:AAPL`, `NYSE:JPM`, `AMEX:SPY` | `AAPL.US`, `JPM.US`, `SPY.US` | yfinance |
| `HKEX:700` | `700.HK` | yfinance |
| `TSX:TD` / `TSXV:PNG` | `TD.TO` / `PNG.V` | yfinance |
| `BINANCE:BTCUSDT`, `OKX:BTCUSDT`, `COINBASE:BTCUSD` | `BTC-USDT` (hyphen, never slash) | okx |
| `SSE:600519` / `SZSE:000001` | `600519.SH` / `000001.SZ` | tushare / akshare |

Get the exact TradingView symbol from `chart_get_state` or `symbol_info`. For anything not in the table (continuous futures like `ES1!`, forex, indices), call `search_symbol` (vibe-trading) and confirm the match with the user. If there is no match, say the symbol isn't covered rather than guessing.

### Timeframes (`chart_set_timeframe` → `config.json` `interval`)

| TradingView | `1` | `5` | `15` | `30` | `60` | `240` | `D` | `W` | `M` |
|---|---|---|---|---|---|---|---|---|---|
| Vibe-Trading | `1m` | `5m` | `15m` | `30m` | `1H` | `4H` | `1D` | `1W` | `1M` |

Keep intraday ranges small: at most 30 days for `1m` and about 1 year for `1H`.

## Workflow A: Chart → Backtest

### A1. Read the Chart (compact)
1. `chart_get_state` — symbol, timeframe, indicators (call once)
2. `data_get_study_values` — current indicator readings
3. `data_get_pine_lines` / `data_get_pine_labels` with `study_filter` — custom levels, if a Pine indicator defines the setup
4. `data_get_ohlcv` with `summary: true` — recent price action
5. `capture_screenshot` region "chart" — visual record of the setup

### A2. Turn the Setup into Rules
State the rules back to the user **before** coding: entry, exit, direction, filters, indicator parameters. If the chart shows indicators but the user hasn't said how they trade them, offer 2–3 concrete rule sets and let them choose. Never invent thresholds silently.

Default the period to the last 10 years for daily bars. Ask the user whether to use their own commission or the default of 0.1%.

### A3. Write the Run
Create a run directory under `~/.vibe-trading/runs/<short-name>/` (an allowed run root by default). Use vibe-trading `write_file` with absolute paths:

`config.json`:
```json
{
  "source": "auto",
  "codes": ["AAPL.US"],
  "start_date": "2015-10-21",
  "end_date": "2025-10-21",
  "warmup_bars": 200,
  "interval": "1D",
  "initial_cash": 100000,
  "commission": 0.001,
  "position_adjustment": "hold",
  "validation": {"monte_carlo": {"n_simulations": 1000}, "walk_forward": {"n_windows": 5}}
}
```

- Move `start_date` back to cover the longest lookback, and declare those bars in `warmup_bars` so they aren't graded.
- Use `"hold"` for entry/exit strategies and `"rebalance"` when the target weight itself is the strategy.

`code/signal_engine.py`:
```python
import numpy as np
import pandas as pd
from typing import Dict


class SignalEngine:
    def generate(self, data_map: Dict[str, pd.DataFrame]) -> Dict[str, pd.Series]:
        signals = {}
        for code, df in data_map.items():
            fast = df["close"].ewm(span=20, adjust=False).mean()
            slow = df["close"].ewm(span=50, adjust=False).mean()
            signals[code] = pd.Series(np.where(fast > slow, 1.0, 0.0), index=df.index)
        return signals
```

Contract:
- The engine receives `code → DataFrame` with columns open, high, low, close and volume on a DatetimeIndex. It returns `code → Series` in `[-1, 1]`, where 1 is fully long, 0 is flat and -1 is fully short.
- The index must match the input exactly. Use pandas/numpy only. Don't hardcode dates or codes, and don't add a `__main__` block.
- Signals execute at the **next bar's open**, which is the same as Pine's default. Don't shift them yourself.

For a deeper reference, `load_skill("strategy-generate")` (vibe-trading) has the full config and validation options.

### A4. Run and Read
1. `backtest(run_dir=...)` — newer releases return a structured `summary`; read that rather than `stdout`. Older releases, such as 0.1.16 on PyPI, return only `status`, `exit_code`, `stdout`, `stderr`, `artifacts` and `run_dir`. For those, read the metrics from `artifacts/metrics.csv`.
2. If `status` is `"error"`, read the end of `stderr`. `NoAvailableSourceError` means the data source was unreachable or the symbol is unknown, not a strategy bug: tell the user and stop. If it ran but `trade_count == 0`, fix `signal_engine.py` and rerun. Zero trades means a signal bug, not a result.
3. For trade and equity detail, use `read_run_artifact(run_dir, "trades")` and `read_run_artifact(run_dir, "equity", format="downsample", max_rows=50)`. If `read_run_artifact` doesn't exist (older releases), use `read_file` on `artifacts/trades.csv`, and summarize the equity curve rather than pasting it.
4. Optionally run `pattern_recognition(run_dir)` to check whether the chart pattern the user sees shows up in the data.

### A5. Report
Lead with **trade count**, then the Monte Carlo p-value and walk-forward consistency, and only then return, Sharpe and max drawdown. A strategy with few trades or one that fails walk-forward is unproven, whatever its return. Quote only figures that appear in tool output.

## Workflow B: Backtest → Pine → Strategy Tester

### B1. Translate
Read the run's `config.json` and `code/signal_engine.py`; `read_file` works for both. `load_skill("pine-script")` (vibe-trading) has a Python→Pine mapping. Its table is a starting point only, so check each call against Pine v6. In particular, Pine v6 has no `ta.adx`: use `[diPlus, diMinus, adx] = ta.dmi(diLen, adxSmoothing)`. Also, `ta.stoch(source, high, low, length)` returns %K only, so smooth it yourself for %D.

Match the backtest's assumptions in the `strategy()` header so results are comparable:
```pinescript
//@version=6
strategy("VT: <name>", overlay=true, initial_capital=100000,
     default_qty_type=strategy.percent_of_equity, default_qty_value=100,
     commission_type=strategy.commission.percent, commission_value=0.1)
```
`commission` 0.001 in `config.json` = `commission_value=0.1` (percent). Leave `process_orders_on_close` off so fills stay at the next bar's open.

### B2. Load and Compile
1. `chart_set_symbol` / `chart_set_timeframe` to the run's symbol and interval
2. `pine_new` with type "strategy", then `pine_set_source`
3. `pine_smart_compile` → `pine_get_errors`; fix and repeat until clean (see the `pine-develop` skill for the loop)
4. Only `pine_save` if the user asks to keep it

### B3. Compare
1. `data_get_strategy_results`, `data_get_trades`, and `capture_screenshot` region "strategy_tester"
2. Put the two results side by side: trade count, win rate, net return and max drawdown.
3. Expect differences, and explain each one rather than hiding it:
   - **Data**: TradingView's feed versus yfinance or OKX. Check `_provenance.adjustment` from `get_market_data`, since split/dividend adjustment shifts price levels.
   - **Period**: the Strategy Tester covers only the bars loaded on the chart. Compare over the same window.
   - **Sizing**: `"rebalance"` resizes positions, while Pine `percent_of_equity` sizes once per entry.

   If trade counts differ by more than a few, the translation is wrong. Diff the entry conditions before trusting either number.

## Workflow C: Context Enrichment

After `chart_get_state` / `quote_get`, map the symbol (table above) and pull only what the question needs:
- `get_stock_profile` — company profile and key stats
- `get_stock_news` — recent headlines (`limit: 10`)
- `get_financial_statements` / `get_fundamentals` — statements and ratios
- `get_sec_filings` — US filings
- `get_options_chain` — expirations and strikes for an options view
- `technical_indicators` — an independent RSI/MACD/BB calculation to cross-check `data_get_study_values`

Present chart readings and Vibe-Trading data in separate, labelled sections so the user knows which source each number came from.

## Rules

- **Research only.** Don't call the vibe-trading `trading_*` connector tools unless the user explicitly asks about a broker account. Never route anything toward order placement.
- **Context budget.** Keep `get_market_data` `max_rows` at its default of 250 or lower. Use `read_run_artifact` with `downsample` instead of reading CSVs in full. Follow the context rules in tradingview-mcp's `CLAUDE.md`: `summary: true` on `data_get_ohlcv`, and `study_filter` on the pine tools.
- **No silent assumptions.** Tell the user every default you chose: period, commission, sizing and symbol mapping.
