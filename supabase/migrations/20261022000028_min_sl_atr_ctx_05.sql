-- 20 Okt 2026 malam: gate volatilitas live dilonggarkan (pilihan pengguna) — SL tetap minimal 0,5× ATR konteks (sebelumnya 0,6).
-- Backtest riset dipatok di 0,6 di edge function, jadi hash versi backtest tidak berubah.
update engine_state set config = jsonb_set(config, '{minSlAtrContext}', '0.5');
