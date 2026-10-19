-- Atas permintaan pengguna (19 Okt 2026, "jangan terlalu ketat"): gate live dilonggarkan sedang.
--   minSlAtrContext 0,75 → 0,6 (SL tetap 50 pips ditolak saat ATR M15 ±$7 padahal setup sd_reversal 09:19 WIB mencapai TP1)
--   invalidationTolPips 0 → 5 (SL boleh maks. 5 pips di dalam invalidasi struktur)
-- Backtest XAU/USD meriset kedua nilai ini; kembalikan dengan menghapus kuncinya bila hasilnya buruk.
update public.engine_state
set config = config || jsonb_build_object('minSlAtrContext', 0.6, 'invalidationTolPips', 5)
where id = 'engine';
