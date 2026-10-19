-- Waktu TP tertinggi (outcome_tp) pertama tersentuh. Dipakai agar BE (SL ke entry setelah TP1)
-- hanya berlaku sejak TP benar-benar tersentuh, termasuk TP yang tercatat dari tick harga.
alter table public.setups add column if not exists outcome_tp_at timestamptz;
