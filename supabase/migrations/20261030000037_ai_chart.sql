-- Analisa AI dari gambar (eksperimen, 30 Okt 2026): screenshot XAUUSD → setup satu TP (RR 1:5–1:6).
-- Terpisah dari setups engine: tidak masuk rekap/statistik engine. Ditulis oleh edge function chart-ai
-- (service role) dan dilacak engine tick; pengguna hanya membaca & menghapus miliknya.
create table if not exists public.ai_analyses (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  created_at     timestamptz not null default now(),
  image_path     text not null check (char_length(image_path) <= 300),
  tf             text not null check (tf in ('M5','M15','M30','H1','H4')),
  note           text not null default '' check (char_length(note) <= 300),
  provider       text check (char_length(provider) <= 40),
  model          text check (char_length(model) <= 80),
  price          double precision,
  raw            jsonb,
  bias           text check (char_length(bias) <= 20),
  summary        text check (char_length(summary) <= 600),
  structure      jsonb not null default '[]',
  notes          jsonb not null default '[]',
  status         text not null check (status in ('failed','no_setup','rejected','pending','entry_touched','expired','invalid','closed')),
  reject_reason  text check (char_length(reject_reason) <= 400),
  direction      text check (direction in ('BUY','SELL')),
  entry_type     text check (entry_type in ('market','limit')),
  entry          double precision,
  sl             double precision,
  tp             double precision,
  rr             double precision,
  sl_pips        double precision,
  tp_pips        double precision,
  target_reason  text check (char_length(target_reason) <= 600),
  invalidation   text check (char_length(invalidation) <= 400),
  reasons        jsonb not null default '[]',
  expires_at     timestamptz,
  entry_touched_at timestamptz,
  outcome        text check (outcome in ('open','win','loss','timeout')),
  outcome_pips   double precision,
  outcome_r      double precision,
  outcome_at     timestamptz,
  outcome_note   text check (char_length(outcome_note) <= 300),
  updated_at     timestamptz not null default now(),
  check (status not in ('pending','entry_touched','expired','invalid','closed') or (direction is not null and entry is not null and sl is not null and tp is not null))
);
create index if not exists ai_analyses_user_created on public.ai_analyses (user_id, created_at desc);
create index if not exists ai_analyses_active on public.ai_analyses (status) where status in ('pending','entry_touched');

alter table public.ai_analyses enable row level security;
create policy "ai own read" on public.ai_analyses for select to authenticated using (user_id = (select auth.uid()));
create policy "ai own delete" on public.ai_analyses for delete to authenticated using (user_id = (select auth.uid()));

-- screenshot privat per pengguna (folder pertama = user id), sama seperti journal-screenshots
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chart-uploads', 'chart-uploads', false, 4194304, array['image/png','image/jpeg','image/webp'])
on conflict (id) do update set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types, public = false;

create policy "chart uploads own read" on storage.objects for select to authenticated
  using (bucket_id = 'chart-uploads' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "chart uploads own insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'chart-uploads' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "chart uploads own delete" on storage.objects for delete to authenticated
  using (bucket_id = 'chart-uploads' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- realtime: halaman ikut berubah saat engine mencatat entry/hasil
do $$ begin
  alter publication supabase_realtime add table public.ai_analyses;
exception when duplicate_object then null; end $$;
