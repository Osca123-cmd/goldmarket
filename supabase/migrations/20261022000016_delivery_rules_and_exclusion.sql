-- Atas permintaan pengguna (19 Okt 2026), setelah volatilitas tiba-tiba saat pembukaan London:
--  1) aturan PENGIRIMAN sinyal live: 1 sinyal sekaligus (sampai selesai/TP1), dan 14.00–17.00 WIB hanya
--     entry stop/market dengan maks 1 sinyal per hari. Deteksi, SL/TP, dan backtest tidak berubah.
--  2) sinyal bisa dikecualikan dari statistik tanpa dihapus (tetap tampil dengan badge & alasan).
alter table public.setups
  add column if not exists excluded boolean not null default false,
  add column if not exists excluded_reason text;

update public.engine_state
set config = config || jsonb_build_object('delivery', jsonb_build_object(
  'oneAtATime', true,
  'windows', jsonb_build_array(jsonb_build_object(
    'label', '14.00–17.00 WIB', 'startHour', 14, 'endHour', 17, 'utcOffsetHours', 7,
    'entryTypes', jsonb_build_array('stop', 'market'), 'maxPerDay', 1))))
where id = 'engine';

update public.setups
set excluded = true,
    excluded_reason = 'Dikecualikan oleh pengguna (19 Okt): volatilitas tiba-tiba saat pembukaan London; aturan 14.00–17.00 WIB ditambahkan setelahnya.'
where id = 'bbea5853-9957-4a7a-85b7-62a9698ccd80';
