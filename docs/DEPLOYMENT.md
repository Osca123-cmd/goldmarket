# Panduan Deployment

## 1. Supabase (backend)

Project yang sudah dibuat: `goldmarket` (ref `acyvxbqyxdorkrqeibtk`, region ap-southeast-1). Untuk project baru:

1. Buat project Supabase.
2. Terapkan migrasi berurutan:
   - `supabase/migrations/20261017000001_init.sql` — tabel, RLS, trigger validasi & histori jurnal, RPC, bucket storage, publikasi realtime.
   - `supabase/migrations/20261017000002_cron.sql` — pg_cron, pg_net, `invoke_engine`, `engine_secret_ok`, jadwal tick/backtest/cleanup.
3. Buat secret di Vault (SQL editor):
   ```sql
   select vault.create_secret('https://<ref>.supabase.co/functions/v1/engine', 'engine_url');
   select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'engine_secret');
   ```
   Engine memverifikasi header `x-engine-secret` terhadap Vault (atau env `ENGINE_SECRET` bila diset — harus sama).
4. Deploy Edge Function:
   ```bash
   npm run sync:core
   supabase functions deploy engine --no-verify-jwt
   ```
5. Secret Edge Function (opsional): `supabase secrets set MARKET_PROVIDER=twelvedata TWELVEDATA_API_KEY=... QUOTE_INTERVAL_SEC=300`.
   Variabel lain: `MAX_RETRIES` (6), `ASSUMED_SPREAD_PIPS` (3), `TD_CREDITS_PER_RUN` (6), `TD_INCLUDE_M1` (false), `BACKTEST_BARS` (1500).
6. Auth → URL Configuration: isi **Site URL** dengan URL frontend dan tambahkan `<url>/login/` serta `<url>/reset-password/` ke **Redirect URLs** (dibutuhkan untuk tautan konfirmasi email & reset password). Untuk produksi, pasang SMTP sendiri (SMTP bawaan Supabase dibatasi beberapa email/jam).

Konfigurasi engine tanpa deploy ulang:
```sql
update public.engine_state set config = jsonb_build_object('provider','binance_paxg','minRrAfterCost',1.5,'engineMinScore',40) where id='engine';
```

## 2. Frontend (static export)

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co \
NEXT_PUBLIC_SUPABASE_ANON_KEY=<publishable-key> \
npm run build          # hasil di out/
```

Hosting aktif: **https://osca123-cmd.github.io/goldmarket/** (GitHub Pages dari branch `gh-pages`). Deploy ulang: `./scripts/deploy-gh-pages.sh`.

Hosting statis lain:
- **Vercel**: import repo `Osca123-cmd/goldmarket` (Root Directory default `./`), Framework Next.js, set dua env var di atas.
- **Netlify / Cloudflare Pages**: build command `npm run build`, publish directory `out`.
- **GitHub Pages / subpath**: set `NEXT_PUBLIC_BASE_PATH=/<repo>` saat build. Workflow contoh: `docs/github-pages-workflow.yml`.

Anon/publishable key aman di browser karena semua tabel dilindungi RLS; service role key **tidak pernah** dipakai di frontend.

## 3. Pemeriksaan pasca-deploy

```sql
select jobname, schedule, active from cron.job;                          -- 3 job
select id, mode, ok, message, stats from public.engine_runs order by id desc limit 5;
select source, price, feed_status, quote_time from public.market_snapshot;
```
Advisor keamanan: `engine_state` sengaja tanpa policy (tertutup untuk klien). `pg_net` terpasang di schema `public` (default Supabase); opsional pindahkan dengan `drop extension pg_net; create extension pg_net schema extensions;` lalu buat ulang `invoke_engine`.
