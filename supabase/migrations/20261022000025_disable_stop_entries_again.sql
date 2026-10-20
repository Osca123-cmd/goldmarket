-- Atas permintaan pengguna (20 Okt 2026 sore): entry stop dimatikan lagi (stop "kembali ke zona" pertama live -50),
-- hanya limit/market yang dikirim. Sinyal stop MSNR SELL M15 4119.68 ditandai dikecualikan.
update public.engine_state
set config = jsonb_set(config #- '{delivery,stopKinds}', '{delivery,entryTypes}', jsonb_build_array('limit', 'market'))
where id = 'engine';

update public.setups
set excluded = true, excluded_reason = 'Entry stop — dimatikan lagi 20 Okt sore atas permintaan pengguna (tidak dihitung).'
where id = '2d887c31-8262-41fa-bb93-a078f5bb7ad8';
