-- 22 Okt 2026 (permintaan pengguna): indikator SIGNAL-HMD pengguna dijadikan strategi ke-9 (EKSPERIMEN), hanya M5,
-- tanpa filter momentum M15; SL/TP rencana engine (M5 = 50/50/100/150 pips), bukan RR indikator.
-- Uji candle XAU/USD Twelve Data 4 Mei–21 Okt (aturan 1 sinyal sekaligus): SIGNAL-HMD 76 trade, win 61%, +32/sinyal;
-- sistem 59,4 → 62,8 sinyal/minggu, +19.610 → +21.860 pips, drawdown 400 → 380.
alter table public.setups drop constraint if exists setups_strategy_check;
alter table public.setups add constraint setups_strategy_check
  check (strategy in ('trend_pullback', 'breakout_retest', 'liquidity_sweep', 'sd_reversal', 'crt', 'msnr_flip', 'fvg_retest', 'order_block', 'chop_breakout', 'smc_choch', 'signal_hmd'));

update public.engine_state
set config = jsonb_set(config, '{strategies}', (config->'strategies') || '["signal_hmd"]'::jsonb)
where id = 'engine' and not (config->'strategies' ? 'signal_hmd');
