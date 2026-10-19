-- Atas permintaan pengguna (20 Okt 2026): jam istirahat 23.10–05.00 WIB — tidak ada sinyal baru, setup yang
-- belum kena entry dibatalkan, sinyal berjalan tetap dilacak, dan rekap hari (05.00–23.10) dikirim.
-- Aturan 1 sinyal sekaligus dan entry hanya limit/market tetap.
update public.engine_state
set config = config || jsonb_build_object('delivery', jsonb_build_object(
  'oneAtATime', true,
  'entryTypes', jsonb_build_array('limit', 'market'),
  'quiet', jsonb_build_object('label', '23.10–05.00 WIB', 'startHour', 23, 'startMinute', 10,
                              'endHour', 5, 'endMinute', 0, 'utcOffsetHours', 7)))
where id = 'engine';
