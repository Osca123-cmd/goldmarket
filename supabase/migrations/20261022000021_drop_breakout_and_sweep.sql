-- Atas permintaan pengguna (20 Okt 2026): Breakout retest & Liquidity sweep dihapus dari sinyal live
-- (tetap disimulasikan di backtest). Strategi live: Supply/Demand reversal + CRT.
update public.engine_state
set config = jsonb_set(config, '{strategies}', jsonb_build_array('sd_reversal', 'crt'))
where id = 'engine';
