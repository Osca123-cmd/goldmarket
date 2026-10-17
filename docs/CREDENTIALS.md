# Integrasi yang Masih Membutuhkan Kredensial / Langkah Manual

| Item | Status | Yang perlu dilakukan |
|---|---|---|
| Data XAUUSD spot (Twelve Data) | **Belum** — saat ini memakai proxy Binance PAXG/USDT | Daftar di twelvedata.com, lalu di Supabase Dashboard → Edge Functions → Secrets: `TWELVEDATA_API_KEY`, `MARKET_PROVIDER=twelvedata`, `QUOTE_INTERVAL_SEC=300` (paket gratis). Periksa lisensi untuk penggunaan Anda. |
| Hosting frontend | Build siap (`out/`) | Hubungkan repo ke Vercel/Netlify/Cloudflare Pages (lihat `DEPLOYMENT.md`) — membutuhkan login akun hosting Anda. |
| Auth Site URL & Redirect URLs | Default `localhost` | Supabase → Authentication → URL Configuration: isi URL hosting, tambahkan `/login/` & `/reset-password/`. Wajib agar tautan konfirmasi email & reset password mengarah ke situs. |
| SMTP email | SMTP bawaan Supabase (terbatas) | Pasang SMTP (Resend, Postmark, dll.) untuk produksi. |
| Job pembersihan data lama | Fungsi ada di migrasi, belum terjadwal | Jalankan bagian `goldmarket_cleanup` dari `supabase/migrations/20261017000002_cron.sql` di SQL editor (butuh konfirmasi karena berisi DELETE). |
| Web Push (notifikasi saat tab tertutup) | Belum (opsional) | Saat ini notifikasi browser hanya saat tab terbuka. Web Push membutuhkan kunci VAPID + service worker. |
| WebSocket provider | Tidak dipakai | Twelve Data WebSocket butuh paket berbayar; browser sudah menerima pembaruan via Supabase Realtime (WebSocket). |
| Kalender libur pasar | Kosong | Isi `holidays` di jadwal (`src/core/sessions.ts`) atau gunakan provider yang mengirim status pasar (Twelve Data `is_market_open` sudah dipakai otomatis). |
