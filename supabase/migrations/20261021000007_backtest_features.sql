-- Ciri setup per trade simulasi (riset filter entry) — lihat src/core/features.ts
alter table public.backtest_trades add column if not exists features jsonb;
