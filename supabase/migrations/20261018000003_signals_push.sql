-- Riwayat sinyal (hasil menurut feed) + Web Push ke HP.

alter table public.setups
  add column if not exists outcome text check (outcome in ('open','win','loss','timeout')),
  add column if not exists outcome_tp int check (outcome_tp between 0 and 3),
  add column if not exists outcome_pips double precision,
  add column if not exists outcome_at timestamptz,
  add column if not exists outcome_note text,
  add column if not exists outcome_ambiguous boolean not null default false;
create index if not exists setups_outcome_idx on public.setups (outcome, entry_touched_at desc);

-- Langganan Web Push per perangkat
create table public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint    text not null unique check (endpoint ~ '^https://' and char_length(endpoint) <= 1000),
  p256dh      text not null check (char_length(p256dh) <= 200),
  auth        text not null check (char_length(auth) <= 100),
  user_agent  text check (char_length(user_agent) <= 300),
  created_at  timestamptz not null default now(),
  last_ok_at  timestamptz,
  failures    int not null default 0
);
alter table public.push_subscriptions enable row level security;
create policy "own push select" on public.push_subscriptions for select to authenticated using (user_id = (select auth.uid()));
create policy "own push insert" on public.push_subscriptions for insert to authenticated with check (user_id = (select auth.uid()));
create policy "own push delete" on public.push_subscriptions for delete to authenticated using (user_id = (select auth.uid()));
create trigger t_push_rl before insert on public.push_subscriptions for each row execute function public.enforce_write_rate_limit('created_at', '10');

-- Kunci publik VAPID (boleh dibaca klien); kunci privat hanya di Vault
create table public.push_config (
  id         text primary key default 'vapid' check (id = 'vapid'),
  public_key text not null,
  created_at timestamptz not null default now()
);
alter table public.push_config enable row level security;
create policy "read push config" on public.push_config for select to authenticated using (true);

create or replace function public.vapid_get() returns jsonb
language sql security definer set search_path = '' stable as $$
  select jsonb_build_object(
    'public', (select public_key from public.push_config where id = 'vapid'),
    'private', (select decrypted_secret from vault.decrypted_secrets where name = 'vapid_private'));
$$;
create or replace function public.vapid_set(p_public text, p_private text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.push_config where id = 'vapid') then return; end if;
  perform vault.create_secret(p_private, 'vapid_private');
  insert into public.push_config (id, public_key) values ('vapid', p_public);
end $$;
revoke execute on function public.vapid_get() from anon, authenticated, public;
revoke execute on function public.vapid_set(text, text) from anon, authenticated, public;
grant execute on function public.vapid_get() to service_role;
grant execute on function public.vapid_set(text, text) to service_role;

alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check check (kind in ('new_setup','confirmed','entry_touched','invalid','expired','connection','signal_result'));

-- basis spot − PAXG untuk provider spot_hybrid
alter table public.engine_state add column if not exists basis double precision;
