-- 23 Okt 2026 (permintaan pengguna): strategi ke-6 "S/R Market Entry" (EKSPERIMEN) — entry market di sentuhan pertama
-- support/resistance M15, tanpa model AI (model regresi logistik yang diuji tidak bisa memilih level, AUC uji 0,50).
-- Uji XAU/USD (aturan 1 sinyal sekaligus, + 5 strategi live): Mei–Okt 2026 +16.520 → +23.310 pips; periode independen
-- Mei–Okt 2025 +13.750 → +15.972 pips, naik di kedua paruh keduanya.
alter table public.setups drop constraint if exists setups_strategy_check;
alter table public.setups add constraint setups_strategy_check
  check (strategy in ('trend_pullback', 'breakout_retest', 'liquidity_sweep', 'sd_reversal', 'crt', 'msnr_flip', 'fvg_retest', 'order_block', 'chop_breakout', 'smc_choch', 'signal_hmd', 'sr_market'));

update public.engine_state
set config = jsonb_set(config, '{strategies}', (config->'strategies') || '["sr_market"]'::jsonb)
where id = 'engine' and not (config->'strategies' ? 'sr_market');
