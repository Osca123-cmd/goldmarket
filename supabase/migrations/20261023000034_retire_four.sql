-- 23 Okt 2026 (permintaan pengguna): Order Block, Liquidity sweep, CRT, dan Breakout retest dihapus dari sinyal live.
-- Strategi live tersisa: Supply/Demand reversal, FVG retest, Breakout kandang babi, SMC sweep + CHoCH + FVG, SIGNAL-HMD (M5).
-- Detektor tetap ada di kode (setup lama tetap tampil dengan label "nonaktif"; backtest riset tetap mensimulasikan
-- Breakout retest & Liquidity sweep sehingga hash riset tidak berubah).
update public.engine_state
set config = jsonb_set(config, '{strategies}', '["sd_reversal","fvg_retest","chop_breakout","smc_choch","signal_hmd"]'::jsonb)
where id = 'engine';
