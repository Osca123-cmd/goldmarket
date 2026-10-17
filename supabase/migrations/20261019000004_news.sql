-- News AI: berita emas (RSS gratis) + kalender ekonomi (ForexFactory) + push sebelum news besar.

create table public.news_items (
  id           uuid primary key default gen_random_uuid(),
  dedupe_key   text not null unique check (char_length(dedupe_key) <= 200),
  title        text not null check (char_length(title) <= 300),
  link         text not null check (link ~ '^https?://' and char_length(link) <= 1000),
  source       text not null check (char_length(source) <= 80),
  feed         text not null check (char_length(feed) <= 40),
  published_at timestamptz,
  snippet      text not null default '' check (char_length(snippet) <= 300),
  label        text not null check (label in ('bullish','bearish','neutral')),
  confidence   text not null check (confidence in ('rendah','sedang')),
  conflict     boolean not null default false,
  rule_ids     text[] not null default '{}',
  reasons      jsonb not null default '[]'::jsonb,
  explanation  text not null,
  relevance    double precision,
  created_at   timestamptz not null default now()
);
create index news_items_pub_idx on public.news_items (published_at desc nulls last);

create table public.econ_events (
  event_key  text primary key check (char_length(event_key) <= 200),
  title      text not null check (char_length(title) <= 120),
  country    text not null check (char_length(country) <= 8),
  impact     text not null check (impact in ('High','Medium','Low','Holiday')),
  time_at    timestamptz not null,
  forecast   text check (char_length(forecast) <= 20),
  previous   text check (char_length(previous) <= 20),
  fetched_at timestamptz not null default now()
);
create index econ_events_time_idx on public.econ_events (time_at);

alter table public.news_items  enable row level security;
alter table public.econ_events enable row level security;
create policy "read news" on public.news_items  for select to authenticated using (true);
create policy "read econ" on public.econ_events for select to authenticated using (true);

-- Preferensi: berapa menit sebelum news besar push dikirim (toggle via notify_kinds.news_event)
alter table public.user_settings
  add column if not exists news_alert_minutes int not null default 30 check (news_alert_minutes between 5 and 240);

alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('new_setup','confirmed','entry_touched','invalid','expired','connection','signal_result','news_event'));

alter publication supabase_realtime add table public.news_items, public.econ_events;

-- Engine mode "news" tiap 15 menit
select cron.schedule('goldmarket-news', '*/15 * * * *', $$select public.invoke_engine('news')$$);

-- Pembersihan harian juga merapikan berita (>7 hari) dan event kalender (>14 hari)
create or replace function public.goldmarket_cleanup() returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.analysis_snapshots where created_at < now() - interval '3 days';
  delete from public.engine_runs where started_at < now() - interval '7 days';
  delete from public.market_candles where timeframe = 'M1' and ts < now() - interval '7 days';
  delete from public.market_candles where timeframe = 'M5' and ts < now() - interval '120 days';
  delete from public.news_items where coalesce(published_at, created_at) < now() - interval '7 days';
  delete from public.econ_events where time_at < now() - interval '14 days';
  delete from public.user_alerts where dedupe_key like 'news:%' and created_at < now() - interval '14 days';
  delete from net._http_response where created < now() - interval '1 day';
end $$;
revoke execute on function public.goldmarket_cleanup() from anon, authenticated, public;
