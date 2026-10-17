-- Penjadwalan engine. URL & secret disimpan di Supabase Vault (tidak di-hardcode):
--   select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/engine', 'engine_url');
--   select vault.create_secret('<random-secret>', 'engine_secret');
-- Nilai engine_secret harus sama dengan secret Edge Function ENGINE_SECRET.

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.invoke_engine(p_mode text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare req_id bigint;
begin
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'engine_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-engine-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'engine_secret')),
    body := jsonb_build_object('mode', p_mode),
    timeout_milliseconds := 120000
  ) into req_id;
  return req_id;
end $$;
revoke execute on function public.invoke_engine(text) from anon, authenticated, public;

-- tiap menit: ambil data, validasi, analisis, update setup & notifikasi
select cron.schedule('goldmarket-engine-tick', '* * * * *', $$select public.invoke_engine('tick')$$);
-- harian 00:20 UTC: backtest walk-forward untuk probabilitas historis
select cron.schedule('goldmarket-backtest', '20 0 * * *', $$select public.invoke_engine('backtest')$$);
-- harian 01:00 UTC: pembersihan data lama
create or replace function public.goldmarket_cleanup() returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.analysis_snapshots where created_at < now() - interval '3 days';
  delete from public.engine_runs where started_at < now() - interval '7 days';
  delete from public.market_candles where timeframe = 'M1' and ts < now() - interval '7 days';
  delete from public.market_candles where timeframe = 'M5' and ts < now() - interval '120 days';
  delete from net._http_response where created < now() - interval '1 day';
end $$;
revoke execute on function public.goldmarket_cleanup() from anon, authenticated, public;
select cron.schedule('goldmarket-cleanup', '0 1 * * *', 'select public.goldmarket_cleanup()');

-- Edge Function memverifikasi pemanggil terhadap Vault (hanya service_role yang boleh memanggil).
create or replace function public.engine_secret_ok(p_secret text) returns boolean
language sql security definer set search_path = '' stable as $$
  select exists (select 1 from vault.decrypted_secrets where name = 'engine_secret' and decrypted_secret = p_secret);
$$;
revoke execute on function public.engine_secret_ok(text) from anon, authenticated, public;
grant execute on function public.engine_secret_ok(text) to service_role;
