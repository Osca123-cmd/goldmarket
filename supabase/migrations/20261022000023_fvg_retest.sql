-- Atas permintaan pengguna (20 Okt 2026): strategi FVG retest live sebagai EKSPERIMEN, dua arah (seperti MSNR flip),
-- SL/TP sama dengan rencana per TF. Strategi live: Supply/Demand reversal, CRT, MSNR flip, FVG retest.
alter table public.setups drop constraint if exists setups_strategy_check;
alter table public.setups add constraint setups_strategy_check
  check (strategy in ('trend_pullback', 'breakout_retest', 'liquidity_sweep', 'sd_reversal', 'crt', 'msnr_flip', 'fvg_retest'));

update public.engine_state
set config = jsonb_set(config, '{strategies}', jsonb_build_array('sd_reversal', 'crt', 'msnr_flip', 'fvg_retest'))
where id = 'engine';
