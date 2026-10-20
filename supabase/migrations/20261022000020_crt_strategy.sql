-- Atas permintaan pengguna (20 Okt 2026): strategi CRT (Candle Range Theory) live sebagai EKSPERIMEN,
-- SL/TP sama dengan rencana per TF. Kembalikan dengan menghapus 'crt' dari config.strategies.
alter table public.setups drop constraint if exists setups_strategy_check;
alter table public.setups add constraint setups_strategy_check
  check (strategy in ('trend_pullback', 'breakout_retest', 'liquidity_sweep', 'sd_reversal', 'crt'));

update public.engine_state
set config = jsonb_set(config, '{strategies}', jsonb_build_array('breakout_retest', 'sd_reversal', 'liquidity_sweep', 'crt'))
where id = 'engine';
