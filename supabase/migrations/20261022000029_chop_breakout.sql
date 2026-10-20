-- 20 Okt 2026 malam (permintaan pengguna): strategi "Breakout kandang babi" live sebagai EKSPERIMEN.
-- Kotak = 4 candle H1 ≤ 2 ATR; close M15 pertama di luar kotak dengan badan ≥ 0,5 ATR M15; entry limit retest tepi kotak,
-- SL/TP rencana M30. Uji candle nyata 30 Agu–19 Okt (kode produksi): 27 trade 17W/10L +1.529 pips (+56,6/sinyal).
alter table public.setups drop constraint if exists setups_strategy_check;
alter table public.setups add constraint setups_strategy_check
  check (strategy in ('trend_pullback', 'breakout_retest', 'liquidity_sweep', 'sd_reversal', 'crt', 'msnr_flip', 'fvg_retest', 'order_block', 'chop_breakout'));

update public.engine_state
set config = jsonb_set(config, '{strategies}', (config->'strategies') || '["chop_breakout"]'::jsonb)
where id = 'engine' and not (config->'strategies' ? 'chop_breakout');
