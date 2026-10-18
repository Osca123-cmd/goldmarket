-- API key Twelve Data boleh disimpan di Vault (alternatif secret Edge Function TWELVEDATA_API_KEY):
--   select vault.create_secret('<api-key>', 'twelvedata_api_key');
-- Hanya service_role (engine) yang dapat membacanya; tidak pernah dikirim ke browser.
create or replace function public.twelvedata_key_get() returns text
language sql security definer set search_path = '' stable as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'twelvedata_api_key' limit 1;
$$;
revoke execute on function public.twelvedata_key_get() from anon, authenticated, public;
grant execute on function public.twelvedata_key_get() to service_role;
