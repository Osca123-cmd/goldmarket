-- News AI v2 (27 Okt 2026): bias BUY/SELL XAUUSD dengan kekuatan lemah/sedang/kuat.
-- Kekuatan disimpan di kolom confidence: lemah → rendah, sedang → sedang, kuat → tinggi.
alter table public.news_items drop constraint if exists news_items_confidence_check;
alter table public.news_items add constraint news_items_confidence_check check (confidence in ('rendah','sedang','tinggi'));
