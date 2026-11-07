-- Riwayat prediksi arah rilis FOMC/NFP/CPI/PPI (7 Nov 2026): prediksi dibekukan saat rilis (diperbarui engine
-- mode news tiap 15 menit sebelum rilis), lalu dinilai dari reaksi XAU 15/60/240 menit sesudahnya. Disimpan
-- permanen (econ_events & news_items punya retensi), supaya akurasi bisa dinilai dari waktu ke waktu.
create table if not exists public.event_predictions (
  release_key   text primary key check (char_length(release_key) <= 120),
  topic         text not null check (topic in ('FOMC','NFP','CPI','PPI')),
  time_at       timestamptz not null,
  events        jsonb not null default '[]',
  side          text not null check (side in ('BUY','SELL','NETRAL')),
  strength      text check (strength in ('lemah','sedang')),
  score         double precision not null,
  reasons       jsonb not null default '[]',
  scenario      text check (char_length(scenario) <= 400),
  predicted_at  timestamptz not null default now(),
  -- true = dihitung sesudah rilis dari data yang tersedia sebelum rilis (rilis sebelum fitur ini ada)
  backfilled    boolean not null default false,
  status        text not null default 'pending' check (status in ('pending','done','no_data')),
  base_price    double precision,
  move_15m      double precision,
  move_60m      double precision,
  move_240m     double precision,
  hit_15m       boolean,
  hit_60m       boolean,
  hit_240m      boolean,
  evaluated_at  timestamptz
);
create index if not exists event_predictions_time on public.event_predictions (time_at desc);

alter table public.event_predictions enable row level security;
create policy "read event predictions" on public.event_predictions for select to authenticated using (true);
