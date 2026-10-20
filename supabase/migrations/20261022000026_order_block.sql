-- Atas permintaan pengguna (20 Okt 2026 malam): strategi Order Block (versi O2: tidak melawan bias utama) live sebagai
-- EKSPERIMEN, SL/TP sama dengan rencana per TF. Uji candle nyata 30 Agu–19 Okt: 18 trade, 12W/6L, +816 pips (+45/sinyal).
alter table public.setups drop constraint if exists setups_strategy_check;
alter table public.setups add constraint setups_strategy_check
  check (strategy in ('trend_pullback', 'breakout_retest', 'liquidity_sweep', 'sd_reversal', 'crt', 'msnr_flip', 'fvg_retest', 'order_block'));

update public.engine_state
set config = jsonb_set(config, '{strategies}', jsonb_build_array('sd_reversal', 'crt', 'msnr_flip', 'fvg_retest', 'order_block'))
where id = 'engine';
