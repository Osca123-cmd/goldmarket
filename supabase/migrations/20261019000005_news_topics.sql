-- News AI difokuskan ke FOMC, NFP, CPI, PPI saja (berita, kalender, notifikasi).
alter table public.news_items  add column if not exists topic text check (topic in ('FOMC','NFP','CPI','PPI'));
alter table public.econ_events add column if not exists topic text check (topic in ('FOMC','NFP','CPI','PPI'));
create index if not exists news_items_topic_idx on public.news_items (topic, published_at desc);
