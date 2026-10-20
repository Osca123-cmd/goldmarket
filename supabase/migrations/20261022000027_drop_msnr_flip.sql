-- Atas permintaan pengguna (20 Okt 2026 malam): MSNR flip dihapus dari sinyal live (2 sinyal hari ini kena SL walau tren
-- turun searah). Hasil MSNR SELL M30 4115.33 (-70) ditandai dikecualikan (stop SELL M15 4119.68 sudah dikecualikan).
update public.engine_state
set config = jsonb_set(config, '{strategies}', jsonb_build_array('sd_reversal', 'crt', 'fvg_retest', 'order_block'))
where id = 'engine';

update public.setups
set excluded = true, excluded_reason = 'MSNR flip — strategi dihapus 20 Okt malam atas permintaan pengguna (tidak dihitung).'
where id = 'db309a20-d833-4bb4-8cea-44de9d136ad6';
