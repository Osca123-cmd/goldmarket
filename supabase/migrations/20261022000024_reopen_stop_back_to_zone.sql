-- Atas persetujuan pengguna (20 Okt 2026): entry stop dibuka lagi HANYA untuk kasus "harga kembali ke area"
-- (stopKinds = back_to_zone). Stop "di dalam area tanpa konfirmasi" (sumber 3 LOSS live) tetap tidak dikirim.
-- Uji ulang candle nyata 30 Agu–19 Okt: V1 17 sinyal, 10W/7L, +789 pips (rata-rata +46/sinyal) vs stop lama +28/sinyal.
update public.engine_state
set config = jsonb_set(
  jsonb_set(config, '{delivery,entryTypes}', jsonb_build_array('limit', 'market', 'stop')),
  '{delivery,stopKinds}', jsonb_build_array('back_to_zone'))
where id = 'engine';
