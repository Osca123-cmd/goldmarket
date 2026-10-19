-- Atas permintaan pengguna (20 Okt 2026): trend_pullback dihapus dari sinyal live (tidak pernah menghasilkan
-- setup layak sejak 19 Okt). Patokan pengguna: hasil di kondisi pasar live. Kembalikan dengan menambahkannya lagi.
update public.engine_state
set config = jsonb_set(config, '{strategies}', jsonb_build_array('breakout_retest', 'sd_reversal', 'liquidity_sweep'))
where id = 'engine';
