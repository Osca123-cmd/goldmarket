-- Backoff candle terpisah dari feed harga: candle provider gagal tidak menghentikan update harga.
alter table public.engine_state
  add column if not exists candle_failures int not null default 0,
  add column if not exists candle_retry_at timestamptz;
