-- Backtest panjang bertahap (potongan 7 hari dari riwayat Binance PAXG) +
-- perbandingan manajemen posisi. Lihat docs/STRATEGY.md §9 & §13.

-- status pemeliharaan sekali jalan (mis. pembersihan candle di luar jam pasar)
alter table public.engine_state add column if not exists maintenance jsonb not null default '{}'::jsonb;

create table public.backtest_chunks (
  chunk_start timestamptz not null,
  version     text not null check (char_length(version) <= 40),
  computed_at timestamptz not null default now(),
  setups      int not null default 0,
  touched     int not null default 0,
  primary key (chunk_start, version)
);

create table public.backtest_trades (
  id             bigint generated always as identity primary key,
  version        text not null check (char_length(version) <= 40),
  chunk_start    timestamptz not null,
  created_at     timestamptz not null,
  strategy       text not null,
  timeframe      text not null,
  direction      text not null check (direction in ('BUY','SELL')),
  session        text not null,
  sl_pips        double precision not null,
  entry_touched  boolean not null,
  invalid_before boolean not null,
  tp             jsonb not null,
  ambiguous      boolean not null default false,
  pips           jsonb
);
create index backtest_trades_version_idx on public.backtest_trades (version, created_at);
create index backtest_trades_chunk_idx on public.backtest_trades (version, chunk_start);

create table public.strategy_report (
  id          text primary key default 'current' check (id = 'current'),
  version     text not null,
  computed_at timestamptz not null default now(),
  source      text not null,
  chunks      int not null,
  report      jsonb not null
);

alter table public.backtest_chunks enable row level security;
alter table public.backtest_trades enable row level security; -- hanya service role (engine)
alter table public.strategy_report enable row level security;
create policy "read backtest chunks" on public.backtest_chunks for select to authenticated using (true);
create policy "read strategy report" on public.strategy_report for select to authenticated using (true);

-- tiap 10 menit: hitung satu potongan yang belum ada (keluar cepat bila semua sudah final)
select cron.unschedule('goldmarket-backtest');
select cron.schedule('goldmarket-backtest', '*/10 * * * *', $$select public.invoke_engine('backtest')$$);
