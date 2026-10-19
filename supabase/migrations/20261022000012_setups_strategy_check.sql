-- Strategi riset/eksperimen boleh disimpan sebagai setup live (sebelumnya hanya 2 strategi awal,
-- sehingga setup sd_reversal ditolak saat insert).
alter table public.setups drop constraint if exists setups_strategy_check;
alter table public.setups add constraint setups_strategy_check
  check (strategy in ('trend_pullback', 'breakout_retest', 'liquidity_sweep', 'sd_reversal'));
