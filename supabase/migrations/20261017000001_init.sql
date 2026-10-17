-- GOLDMARKET — skema awal
-- Data pasar & analisis ditulis HANYA oleh Edge Function (service role).
-- Data pengguna (pengaturan, jurnal) dibatasi per akun lewat RLS.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- DATA PASAR
-- ---------------------------------------------------------------------------
create table public.market_candles (
  source     text not null,
  timeframe  text not null check (timeframe in ('M1','M5','M15','M30','H1','H4','D1')),
  ts         timestamptz not null,
  open       double precision not null check (open > 0),
  high       double precision not null check (high > 0),
  low        double precision not null check (low > 0),
  close      double precision not null check (close > 0),
  volume     double precision,
  updated_at timestamptz not null default now(),
  primary key (source, timeframe, ts),
  check (high >= greatest(open, close) and low <= least(open, close))
);

create table public.market_snapshot (
  id                   text primary key default 'current' check (id = 'current'),
  source               text not null,
  source_label         text not null,
  proxy_note           text,
  is_demo              boolean not null default false,
  supports_bid_ask     boolean not null default false,
  price                double precision,
  bid                  double precision,
  ask                  double precision,
  spread_pips          double precision,
  day_open             double precision,
  day_high             double precision,
  day_low              double precision,
  day_change           double precision,
  day_change_pct       double precision,
  quote_time           timestamptz,
  fetched_at           timestamptz,
  feed_status          text not null default 'disconnected'
                         check (feed_status in ('live','delayed','reconnecting','disconnected','market_closed','demo')),
  market_open          boolean,
  consecutive_failures int not null default 0,
  next_retry_at        timestamptz,
  last_error           text,
  updated_at           timestamptz not null default now()
);

create table public.engine_state (
  id            text primary key default 'engine' check (id = 'engine'),
  provider      text,
  last_run_at   timestamptz,
  last_success_at timestamptz,
  last_candle_fetch jsonb not null default '{}'::jsonb,
  backfilled    jsonb not null default '{}'::jsonb,
  config        jsonb not null default '{}'::jsonb,
  updated_at    timestamptz not null default now()
);

create table public.engine_runs (
  id          bigint generated always as identity primary key,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  mode        text not null,
  ok          boolean,
  message     text,
  stats       jsonb
);
create index on public.engine_runs (started_at desc);

create table public.analysis_snapshots (
  id              bigint generated always as identity primary key,
  created_at      timestamptz not null default now(),
  source          text not null,
  status          text not null check (status in ('bullish','bearish','ranging','awaiting_confirmation','no_valid_setup')),
  main_bias       text not null check (main_bias in ('bullish','bearish','ranging')),
  strong_bias     boolean not null default false,
  quality_ok      boolean not null,
  quality_reasons text[] not null default '{}',
  reasons         text[] not null default '{}',
  timeframes      jsonb not null default '{}'::jsonb,
  levels          jsonb not null default '[]'::jsonb,
  session         text,
  price           double precision,
  data_time       timestamptz
);
create index on public.analysis_snapshots (created_at desc);

create table public.setups (
  id               uuid primary key default gen_random_uuid(),
  identity_key     text not null unique,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  updated_at       timestamptz not null default now(),
  direction        text not null check (direction in ('BUY','SELL')),
  strategy         text not null check (strategy in ('trend_pullback','breakout_retest')),
  timeframe        text not null check (timeframe in ('M5','M15','M30','H1','H4')),
  confirm_tf       text not null check (confirm_tf in ('M1','M5','M15','M30','H1')),
  entry_type       text not null check (entry_type in ('market','limit','stop')),
  entry_price      double precision not null,
  entry_low        double precision not null,
  entry_high       double precision not null,
  invalidation     double precision,
  sl               double precision not null,
  tp1              double precision not null,
  tp2              double precision not null,
  tp3              double precision not null,
  sl_pips          double precision not null,
  pip_size         double precision not null,
  rr               jsonb not null,
  spread_pips      double precision,
  score            int not null check (score between 0 and 100),
  score_breakdown  jsonb not null,
  gates            jsonb not null,
  eligible         boolean not null,
  reasons          text[] not null default '{}',
  status           text not null check (status in ('approaching','awaiting_confirmation','entry_touched','invalid','expired')),
  status_reason    text,
  confirmed_at     timestamptz,
  confirmation     text,
  entry_touched_at timestamptz,
  last_price       double precision,
  distance_pips    double precision,
  session          text,
  data_source      text not null,
  data_time        timestamptz not null
);
create index on public.setups (status, created_at desc);
create index on public.setups (created_at desc);

create table public.setup_events (
  id         bigint generated always as identity primary key,
  setup_id   uuid not null references public.setups(id) on delete cascade,
  at         timestamptz not null default now(),
  from_status text,
  to_status  text not null,
  event      text not null,
  reason     text,
  price      double precision
);
create index on public.setup_events (setup_id, at);

create table public.notifications (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  kind       text not null check (kind in ('new_setup','confirmed','entry_touched','invalid','expired','connection')),
  dedupe_key text not null unique,
  title      text not null,
  body       text not null,
  severity   text not null default 'info' check (severity in ('info','success','warning','danger')),
  setup_id   uuid references public.setups(id) on delete set null,
  score      int,
  timeframe  text
);
create index on public.notifications (created_at desc);

create table public.probability_stats (
  key          text primary key,
  computed_at  timestamptz not null default now(),
  source       text not null,
  period_from  timestamptz,
  period_to    timestamptz,
  split_at     timestamptz,
  dev          jsonb not null,
  test         jsonb not null,
  sufficient   boolean not null,
  options      jsonb not null
);

-- ---------------------------------------------------------------------------
-- DATA PENGGUNA
-- ---------------------------------------------------------------------------
create table public.user_settings (
  user_id               uuid primary key references auth.users(id) on delete cascade,
  display_tz            text not null default 'Asia/Jakarta' check (char_length(display_tz) between 1 and 64),
  broker_name           text check (char_length(broker_name) <= 80),
  pip_size              numeric not null default 0.1  check (pip_size > 0 and pip_size <= 10),
  tick_size             numeric not null default 0.01 check (tick_size > 0 and tick_size <= 10),
  digits                int     not null default 2    check (digits between 0 and 6),
  contract_size         numeric not null default 100  check (contract_size > 0 and contract_size <= 100000),
  lot_step              numeric not null default 0.01 check (lot_step > 0 and lot_step <= 100),
  min_lot               numeric not null default 0.01 check (min_lot > 0),
  max_lot               numeric not null default 100  check (max_lot > 0),
  commission_per_lot    numeric not null default 0    check (commission_per_lot >= 0),
  account_currency      text    not null default 'USD' check (account_currency ~ '^[A-Z]{3}$'),
  quote_to_account_rate numeric not null default 1    check (quote_to_account_rate > 0),
  account_balance       numeric not null default 1000 check (account_balance >= 0),
  risk_percent          numeric not null default 1    check (risk_percent > 0 and risk_percent <= 100),
  default_spread_pips   numeric not null default 3    check (default_spread_pips >= 0 and default_spread_pips <= 1000),
  sl_pips               numeric not null default 50   check (sl_pips > 0),
  tp1_pips              numeric not null default 50   check (tp1_pips > 0),
  tp2_pips              numeric not null default 100  check (tp2_pips > 0),
  tp3_pips              numeric not null default 150  check (tp3_pips > 0),
  near_entry_pips       numeric not null default 20   check (near_entry_pips > 0 and near_entry_pips <= 1000),
  notify_cooldown_min   int     not null default 15   check (notify_cooldown_min between 0 and 1440),
  min_score             jsonb   not null default '{"M15":60,"H1":60}'::jsonb,
  notify_kinds          jsonb   not null default '{"new_setup":true,"near_entry":true,"confirmed":true,"invalid":true,"expired":true,"connection":true,"entry_touched":true}'::jsonb,
  browser_push          boolean not null default false,
  starting_balance      numeric check (starting_balance is null or starting_balance > 0),
  updated_at            timestamptz not null default now(),
  check (min_lot <= max_lot)
);

create table public.journal_trades (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null default auth.uid() references auth.users(id) on delete cascade,
  setup_id              uuid references public.setups(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  direction             text not null check (direction in ('BUY','SELL')),
  strategy              text not null default 'manual' check (char_length(strategy) between 1 and 40),
  timeframe             text not null default '-' check (char_length(timeframe) between 1 and 8),
  session               text not null default 'off' check (char_length(session) between 1 and 16),
  entry_price           numeric not null check (entry_price > 0),
  lot                   numeric not null check (lot > 0 and lot <= 1000),
  initial_sl            numeric not null check (initial_sl > 0),
  sl                    numeric not null check (sl > 0),
  tp1                   numeric check (tp1 > 0),
  tp2                   numeric check (tp2 > 0),
  tp3                   numeric check (tp3 > 0),
  opened_at             timestamptz not null default now(),
  closed_at             timestamptz,
  status                text not null default 'open' check (status in ('open','closed','cancelled')),
  outcome               text check (outcome in ('tp1','tp2','tp3','sl','be','manual')),
  tp1_hit_at            timestamptz,
  tp2_hit_at            timestamptz,
  tp3_hit_at            timestamptz,
  commission            numeric not null default 0 check (commission >= 0),
  swap                  numeric not null default 0,
  contract_size         numeric not null default 100 check (contract_size > 0),
  quote_to_account_rate numeric not null default 1 check (quote_to_account_rate > 0),
  notes                 text check (char_length(notes) <= 5000),
  check ((direction = 'BUY' and initial_sl < entry_price) or (direction = 'SELL' and initial_sl > entry_price)),
  check ((status = 'closed') = (closed_at is not null and outcome is not null)),
  check (status <> 'cancelled' or outcome is null)
);
create index on public.journal_trades (user_id, opened_at desc);

create table public.journal_partials (
  id        uuid primary key default gen_random_uuid(),
  trade_id  uuid not null references public.journal_trades(id) on delete cascade,
  user_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  closed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  lot       numeric not null check (lot > 0),
  price     numeric not null check (price > 0),
  kind      text not null default 'partial' check (kind in ('partial','final')),
  note      text check (char_length(note) <= 500)
);
create index on public.journal_partials (trade_id);

create table public.journal_events (
  id        bigint generated always as identity primary key,
  trade_id  uuid not null,
  user_id   uuid not null,
  at        timestamptz not null default now(),
  action    text not null,
  before    jsonb,
  after     jsonb
);
create index on public.journal_events (trade_id, at);

create table public.journal_attachments (
  id         uuid primary key default gen_random_uuid(),
  trade_id   uuid not null references public.journal_trades(id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  path       text not null unique,
  mime       text not null check (mime in ('image/png','image/jpeg','image/webp')),
  size_bytes int not null check (size_bytes > 0 and size_bytes <= 5242880),
  created_at timestamptz not null default now()
);

create table public.user_alerts (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  dedupe_key text not null check (char_length(dedupe_key) <= 200),
  created_at timestamptz not null default now(),
  primary key (user_id, dedupe_key)
);

create table public.notification_reads (
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  notification_id uuid not null references public.notifications(id) on delete cascade,
  read_at         timestamptz not null default now(),
  primary key (user_id, notification_id)
);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.market_candles      enable row level security;
alter table public.market_snapshot     enable row level security;
alter table public.engine_state        enable row level security;
alter table public.engine_runs         enable row level security;
alter table public.analysis_snapshots  enable row level security;
alter table public.setups              enable row level security;
alter table public.setup_events        enable row level security;
alter table public.notifications       enable row level security;
alter table public.probability_stats   enable row level security;
alter table public.user_settings       enable row level security;
alter table public.journal_trades      enable row level security;
alter table public.journal_partials    enable row level security;
alter table public.journal_events      enable row level security;
alter table public.journal_attachments enable row level security;
alter table public.user_alerts         enable row level security;
alter table public.notification_reads  enable row level security;

-- data pasar: hanya pengguna login yang dapat membaca (lisensi data provider), tidak ada penulisan dari klien
create policy "read market candles"   on public.market_candles     for select to authenticated using (true);
create policy "read market snapshot"  on public.market_snapshot    for select to authenticated using (true);
create policy "read analysis"         on public.analysis_snapshots for select to authenticated using (true);
create policy "read setups"           on public.setups             for select to authenticated using (true);
create policy "read setup events"     on public.setup_events       for select to authenticated using (true);
create policy "read notifications"    on public.notifications      for select to authenticated using (true);
create policy "read probability"      on public.probability_stats  for select to authenticated using (true);
create policy "read engine runs"      on public.engine_runs        for select to authenticated using (true);
-- engine_state: tidak ada policy → tertutup untuk klien

-- data milik pengguna
create policy "own settings select" on public.user_settings for select to authenticated using (user_id = (select auth.uid()));
create policy "own settings insert" on public.user_settings for insert to authenticated with check (user_id = (select auth.uid()));
create policy "own settings update" on public.user_settings for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy "own trades select" on public.journal_trades for select to authenticated using (user_id = (select auth.uid()));
create policy "own trades insert" on public.journal_trades for insert to authenticated with check (user_id = (select auth.uid()));
create policy "own trades update" on public.journal_trades for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own trades delete" on public.journal_trades for delete to authenticated using (user_id = (select auth.uid()) and status = 'cancelled');

create policy "own partials select" on public.journal_partials for select to authenticated using (user_id = (select auth.uid()));
create policy "own partials insert" on public.journal_partials for insert to authenticated
  with check (user_id = (select auth.uid()) and exists (select 1 from public.journal_trades t where t.id = trade_id and t.user_id = (select auth.uid())));

create policy "own events select" on public.journal_events for select to authenticated using (user_id = (select auth.uid()));

create policy "own attachments select" on public.journal_attachments for select to authenticated using (user_id = (select auth.uid()));
create policy "own attachments insert" on public.journal_attachments for insert to authenticated
  with check (user_id = (select auth.uid()) and path like (select auth.uid())::text || '/%'
              and exists (select 1 from public.journal_trades t where t.id = trade_id and t.user_id = (select auth.uid())));
create policy "own attachments delete" on public.journal_attachments for delete to authenticated using (user_id = (select auth.uid()));

create policy "own alerts select" on public.user_alerts for select to authenticated using (user_id = (select auth.uid()));
create policy "own alerts insert" on public.user_alerts for insert to authenticated with check (user_id = (select auth.uid()));
create policy "own reads select"  on public.notification_reads for select to authenticated using (user_id = (select auth.uid()));
create policy "own reads insert"  on public.notification_reads for insert to authenticated with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- TRIGGER: pengaturan default, validasi server, rate limit, histori jurnal
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.user_settings (user_id) values (new.id) on conflict do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;
create trigger t_settings_touch before update on public.user_settings for each row execute function public.touch_updated_at();
create trigger t_trades_touch   before update on public.journal_trades for each row execute function public.touch_updated_at();

-- rate limit sederhana per pengguna (penulisan jurnal)
create or replace function public.enforce_write_rate_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  execute format('select count(*) from %I.%I where user_id = $1 and %I > now() - interval ''1 minute''',
                 tg_table_schema, tg_table_name, tg_argv[0])
    into n using new.user_id;
  if n >= tg_argv[1]::int then
    raise exception 'rate_limited: terlalu banyak permintaan, coba lagi sebentar lagi' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger t_trades_rl      before insert on public.journal_trades      for each row execute function public.enforce_write_rate_limit('created_at', '30');
create trigger t_partials_rl    before insert on public.journal_partials    for each row execute function public.enforce_write_rate_limit('created_at', '60');
create trigger t_attachments_rl before insert on public.journal_attachments for each row execute function public.enforce_write_rate_limit('created_at', '20');
create trigger t_alerts_rl      before insert on public.user_alerts         for each row execute function public.enforce_write_rate_limit('created_at', '120');

-- validasi perubahan transaksi jurnal
create or replace function public.validate_trade_update() returns trigger
language plpgsql set search_path = '' as $$
declare closed_lot numeric;
begin
  if new.user_id <> old.user_id or new.id <> old.id then
    raise exception 'Pemilik transaksi tidak dapat diubah';
  end if;
  if old.status <> 'open' then
    -- transaksi final: hanya catatan yang boleh diubah
    if (to_jsonb(new) - 'notes' - 'updated_at') <> (to_jsonb(old) - 'notes' - 'updated_at') then
      raise exception 'Transaksi yang sudah selesai/dibatalkan hanya dapat diubah catatannya';
    end if;
    return new;
  end if;
  if new.initial_sl <> old.initial_sl and exists (select 1 from public.journal_partials p where p.trade_id = old.id) then
    raise exception 'SL awal tidak dapat diubah setelah ada partial close';
  end if;
  if (old.tp1_hit_at is not null and new.tp1_hit_at is distinct from old.tp1_hit_at)
     or (old.tp2_hit_at is not null and new.tp2_hit_at is distinct from old.tp2_hit_at)
     or (old.tp3_hit_at is not null and new.tp3_hit_at is distinct from old.tp3_hit_at) then
    raise exception 'Milestone TP yang sudah ditandai tidak dapat diubah';
  end if;
  if new.status = 'closed' then
    select coalesce(sum(lot), 0) into closed_lot from public.journal_partials where trade_id = old.id;
    if closed_lot <> new.lot then
      raise exception 'Penutupan memerlukan harga keluar untuk seluruh lot (tercatat %, lot %)', closed_lot, new.lot;
    end if;
  end if;
  if new.status = 'cancelled' and exists (select 1 from public.journal_partials p where p.trade_id = old.id) then
    raise exception 'Transaksi dengan partial close tidak dapat dibatalkan';
  end if;
  return new;
end $$;
create trigger t_trades_validate before update on public.journal_trades for each row execute function public.validate_trade_update();

create or replace function public.validate_partial_insert() returns trigger
language plpgsql set search_path = '' as $$
declare t public.journal_trades; used numeric;
begin
  select * into t from public.journal_trades where id = new.trade_id for update;
  if t.id is null or t.user_id <> new.user_id then raise exception 'Transaksi tidak ditemukan'; end if;
  if t.status <> 'open' then raise exception 'Transaksi tidak terbuka'; end if;
  select coalesce(sum(lot), 0) into used from public.journal_partials where trade_id = new.trade_id;
  if used + new.lot > t.lot then raise exception 'Lot partial melebihi sisa lot (sisa %)', t.lot - used; end if;
  return new;
end $$;
create trigger t_partials_validate before insert on public.journal_partials for each row execute function public.validate_partial_insert();

-- histori perubahan jurnal (append-only, ditulis server)
create or replace function public.log_journal_event() returns trigger
language plpgsql security definer set search_path = '' as $$
declare tid uuid; uid uuid; act text;
begin
  if tg_table_name = 'journal_trades' then
    tid := coalesce(new.id, old.id); uid := coalesce(new.user_id, old.user_id);
    act := case tg_op when 'INSERT' then 'created' when 'DELETE' then 'deleted'
                      else case when new.status <> old.status then 'status:' || new.status else 'updated' end end;
  else
    tid := coalesce(new.trade_id, old.trade_id); uid := coalesce(new.user_id, old.user_id);
    act := 'partial:' || coalesce(new.kind, old.kind);
  end if;
  insert into public.journal_events (trade_id, user_id, action, before, after)
  values (tid, uid, act,
          case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
          case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end);
  return coalesce(new, old);
end $$;
create trigger t_trades_log   after insert or update or delete on public.journal_trades   for each row execute function public.log_journal_event();
create trigger t_partials_log after insert                     on public.journal_partials for each row execute function public.log_journal_event();

-- RPC atomik: partial close & penutupan transaksi (security invoker → RLS berlaku)
create or replace function public.journal_partial_close(p_trade_id uuid, p_lot numeric, p_price numeric, p_note text default null)
returns void language plpgsql security invoker set search_path = '' as $$
declare t public.journal_trades; used numeric;
begin
  select * into t from public.journal_trades where id = p_trade_id and user_id = auth.uid();
  if t.id is null then raise exception 'Transaksi tidak ditemukan'; end if;
  select coalesce(sum(lot), 0) into used from public.journal_partials where trade_id = p_trade_id;
  if p_lot >= t.lot - used then raise exception 'Lot partial harus lebih kecil dari sisa lot (%)', t.lot - used; end if;
  insert into public.journal_partials (trade_id, lot, price, kind, note) values (p_trade_id, p_lot, p_price, 'partial', p_note);
end $$;

create or replace function public.journal_close_trade(p_trade_id uuid, p_price numeric, p_outcome text, p_closed_at timestamptz default now())
returns void language plpgsql security invoker set search_path = '' as $$
declare t public.journal_trades; used numeric;
begin
  select * into t from public.journal_trades where id = p_trade_id and user_id = auth.uid();
  if t.id is null then raise exception 'Transaksi tidak ditemukan'; end if;
  if t.status <> 'open' then raise exception 'Transaksi tidak terbuka'; end if;
  if p_outcome not in ('tp1','tp2','tp3','sl','be','manual') then raise exception 'Outcome tidak valid'; end if;
  select coalesce(sum(lot), 0) into used from public.journal_partials where trade_id = p_trade_id;
  if t.lot - used > 0 then
    insert into public.journal_partials (trade_id, lot, price, kind, closed_at) values (p_trade_id, t.lot - used, p_price, 'final', p_closed_at);
  end if;
  update public.journal_trades set status = 'closed', outcome = p_outcome, closed_at = p_closed_at where id = p_trade_id;
end $$;

revoke execute on function public.journal_partial_close(uuid, numeric, numeric, text) from anon, public;
revoke execute on function public.journal_close_trade(uuid, numeric, text, timestamptz) from anon, public;
grant execute on function public.journal_partial_close(uuid, numeric, numeric, text) to authenticated;
grant execute on function public.journal_close_trade(uuid, numeric, text, timestamptz) to authenticated;
revoke execute on function public.handle_new_user() from anon, authenticated, public;
revoke execute on function public.enforce_write_rate_limit() from anon, authenticated, public;
revoke execute on function public.log_journal_event() from anon, authenticated, public;

-- ---------------------------------------------------------------------------
-- STORAGE: screenshot jurnal (privat, maks 5 MB, png/jpeg/webp)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('journal-screenshots', 'journal-screenshots', false, 5242880, array['image/png','image/jpeg','image/webp'])
on conflict (id) do update set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types, public = false;

create policy "screenshots own read" on storage.objects for select to authenticated
  using (bucket_id = 'journal-screenshots' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "screenshots own insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'journal-screenshots' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "screenshots own delete" on storage.objects for delete to authenticated
  using (bucket_id = 'journal-screenshots' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ---------------------------------------------------------------------------
-- REALTIME (WebSocket ke browser)
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table public.market_snapshot, public.setups, public.notifications, public.analysis_snapshots;
