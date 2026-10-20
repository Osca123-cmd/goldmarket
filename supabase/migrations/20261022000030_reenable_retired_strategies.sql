-- 21 Okt 2026 pagi: atas permintaan pengguna semua strategi yang pernah dinonaktifkan diaktifkan lagi
-- (trend_pullback, breakout_retest, liquidity_sweep, msnr_flip) di samping 5 strategi live. Entry stop tetap nonaktif.
update public.engine_state
set config = jsonb_set(config, '{strategies}', '["sd_reversal","crt","fvg_retest","order_block","chop_breakout","trend_pullback","breakout_retest","liquidity_sweep","msnr_flip"]'::jsonb)
where id = 'engine';
