-- Atas permintaan pengguna (19 Okt 2026): Liquidity sweep aktif di sinyal LIVE sebagai EKSPERIMEN
-- (berlabel "Eksperimen"), dengan SL/TP/RR sama seperti rencana per TF. Backtest XAU/USD ±5 minggu:
-- 81 trade, TP1 53%, +8,2 pips/trade (1/3 tiap TP + BE). Kembalikan dengan menghapus 'liquidity_sweep'.
update public.engine_state
set config = config || jsonb_build_object('strategies', jsonb_build_array('trend_pullback', 'breakout_retest', 'sd_reversal', 'liquidity_sweep'))
where id = 'engine';
