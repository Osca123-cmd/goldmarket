-- Atas permintaan pengguna (20 Okt 2026): entry STOP dinonaktifkan untuk sinyal live karena hasil live buruk
-- (19 Okt: 1 WIN +50 hanya TP1, 3 LOSS −190 pips). Jendela 14.00–17.00 WIB dibuka kembali. Aturan 1 sinyal
-- sekaligus tetap. Sinyal stop yang sudah ada ditandai DIKECUALIKAN (tetap terlihat, tidak dihitung).
update public.engine_state
set config = config || jsonb_build_object('delivery', jsonb_build_object(
  'oneAtATime', true,
  'entryTypes', jsonb_build_array('limit', 'market')))
where id = 'engine';

update public.setups
set excluded = true,
    excluded_reason = 'Entry stop dinonaktifkan oleh pengguna (20 Okt): hasil live entry stop 1 WIN / 3 LOSS.'
where entry_type = 'stop' and outcome is not null and not excluded;
