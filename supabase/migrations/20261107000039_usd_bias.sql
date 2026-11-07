-- Arah USD hari ini → sinyal XAUUSD (7 Nov 2026). Dihitung engine mode news tiap 15 menit dari EUR/USD M15
-- (Twelve Data, sumber candle 'td_eurusd'), nada berita USD 24 jam, dan tren XAU M15/H1. Riwayat 30 hari.
create table if not exists public.usd_bias (
  id           bigint generated always as identity primary key,
  computed_at  timestamptz not null default now(),
  usd_side     text not null check (usd_side in ('BULLISH','BEARISH','NETRAL')),
  xau_side     text not null check (xau_side in ('BUY','SELL','NETRAL')),
  strength     text check (strength in ('lemah','sedang','kuat')),
  score        double precision not null,
  parts        jsonb not null default '{}',
  reasons      jsonb not null default '[]',
  eurusd       double precision,
  xau_price    double precision
);
create index if not exists usd_bias_time on public.usd_bias (computed_at desc);
alter table public.usd_bias enable row level security;
create policy "read usd bias" on public.usd_bias for select to authenticated using (true);

-- prediksi rilis mencatat arah USD yang dipakai
alter table public.event_predictions add column if not exists usd_side text check (usd_side in ('BULLISH','BEARISH','NETRAL'));
