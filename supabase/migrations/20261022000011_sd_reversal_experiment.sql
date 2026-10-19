-- Atas permintaan pengguna (19 Okt 2026): Supply/Demand reversal aktif di sinyal LIVE sebagai EKSPERIMEN
-- (berlabel "Eksperimen" di kartu & notifikasi) sambil backtest XAU/USD berjalan. Kembalikan dengan
-- menghapus kunci 'strategies' dari config bila hasilnya buruk.
update public.engine_state
set config = config || jsonb_build_object('strategies', jsonb_build_array('trend_pullback', 'breakout_retest', 'sd_reversal'))
where id = 'engine';
