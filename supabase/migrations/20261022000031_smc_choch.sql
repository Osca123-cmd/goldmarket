-- 22 Okt 2026 (permintaan pengguna): Trend pullback & MSNR flip (paling jarang memberi sinyal, ±1/minggu) dimatikan
-- dan diganti strategi SMC "sweep + CHoCH + FVG" (EKSPERIMEN). Uji candle XAU/USD Twelve Data 4 Mei–21 Okt (aturan
-- 1 sinyal sekaligus): 58,9 → 59,4 sinyal/minggu, +19.120 → +19.610 pips, +29,1 → +30,0 pips/sinyal; SMC sendiri
-- 12 trade 10W/2L +920 pips (sampel kecil).
alter table public.setups drop constraint if exists setups_strategy_check;
alter table public.setups add constraint setups_strategy_check
  check (strategy in ('trend_pullback', 'breakout_retest', 'liquidity_sweep', 'sd_reversal', 'crt', 'msnr_flip', 'fvg_retest', 'order_block', 'chop_breakout', 'smc_choch'));

update public.engine_state
set config = jsonb_set(config, '{strategies}', '["sd_reversal","crt","fvg_retest","order_block","chop_breakout","breakout_retest","liquidity_sweep","smc_choch"]'::jsonb)
where id = 'engine';
