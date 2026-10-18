-- Backtest memakai riwayat XAU/USD Twelve Data (4 kredit/potongan): 2× per jam di menit :07 dan :37,
-- saat tick live tidak mengambil candle (tidak ada bar M5 baru) → ≤4 kredit/menit, ≤192/hari.
select cron.schedule('goldmarket-backtest', '7,37 * * * *', $$select public.invoke_engine('backtest')$$);
