# Hasil Pengujian (17 Oktober 2026)

## 1. Unit test — `npm test` (vitest): **44/44 lulus**

| Area (spesifikasi §16) | Test | Hasil |
|---|---|---|
| Pip BUY/SELL, level SL/TP | `pips.test.ts`: 1 pip = 0,10; BUY 3000 → 2995/3005/3010/3015; SELL kebalikan; pip size broker lain; pembulatan tick | ✓ 5/5 |
| Lot, konversi mata uang, pembulatan | `risk.test.ts`: rumus lot; floor ke lot step (risiko ≤ batas); akun IDR via kurs; biaya spread+komisi; validasi SL; lot < minimum; SELL | ✓ 6/6 |
| Analisis tanpa candle masa depan | `engine.test.ts`: hasil analisis di t identik walau data sesudah t tersedia; bar berjalan tidak dipakai konfirmasi | ✓ 2/2 |
| Tidak ada sinyal duplikat | `engine.test.ts`: 72 siklus berurutan → identitas unik & tidak ada setup aktif serupa dalam cooldown | ✓ |
| Data basi menghentikan sinyal | `engine.test.ts`: harga 600 dtk → 0 setup, status "Tidak ada setup valid"; reconnecting & candle hilang → 0 setup; notifikasi koneksi hanya saat transisi | ✓ 3/3 |
| Harga live tidak mengubah jurnal | `journal.test.ts`: pengingat TP1 pada objek beku tidak mengubah SL/status; engine tidak menyentuh data jurnal | ✓ |
| Milestone TP tidak menggandakan statistik | `journal.test.ts`: transaksi dengan TP1+TP2+TP3 + 3 partial = 1 kemenangan, R = 2,1 | ✓ |
| Statistik | win rate, profit factor, BE, drawdown (nominal/R/%), transaksi terbuka & batal dipisah, data kosong tanpa angka karangan, CSV anti formula-injection | ✓ 4/4 |
| Sesi & DST | London 07:00 UTC (BST) / 08:00 UTC (GMT); NY 12:00/13:00 UTC; transisi DST AS 8 Mar & UK 29 Mar 2026; Tokyo; overlap; jadwal pasar akhir pekan & jeda harian | ✓ 7/7 |
| Lifecycle peluang | limit/stop tersentuh; data tidak valid tidak mencatat sentuhan; invalid via close; kedaluwarsa; bias berbalik | ✓ 6/6 |
| Backtest | SL+TP satu candle → ambigu & konservatif; TP sebelum SL; biaya; entry tidak tersentuh; Wilson CI; split dev/test | ✓ 6/6 |

## 2. Database (Supabase, transaksi di-rollback)

| Uji | Hasil |
|---|---|
| Isolasi data antar pengguna (RLS) | Pengguna B melihat 0 transaksi / 0 partial / 0 histori milik A, update ke transaksi A = 0 baris; B hanya melihat pengaturannya sendiri ✓ |
| Histori otomatis | Insert + partial → 2 event tercatat oleh trigger ✓ |
| Tutup tanpa harga keluar seluruh lot | Ditolak ✓ |
| Partial melebihi lot | Ditolak ✓ |
| Menghapus milestone TP | Ditolak ✓ |
| RPC `journal_close_trade` | status `closed/tp1` ✓ |
| Ubah SL transaksi selesai | Ditolak; ubah catatan diizinkan ✓ |
| SL BUY di atas entry | Ditolak (check constraint) ✓ |
| Anon membaca data pasar/setup | 0 baris (hanya pengguna login) ✓ |

## 3. Backend live (Edge Function + pg_cron)

- 40+ run tick berturut-turut sukses; data nyata Binance PAXG/USDT tersimpan: D1 500, H4 1000, H1 2000, M30 2000, M15 3000, M5 5000, M1 1000+ candle.
- Hari uji = Sabtu → status jujur **Market Closed**, kualitas data "Pasar tutup" → **tidak ada sinyal baru** (sesuai spesifikasi).
- Backtest walk-forward di server: 1,6 dtk; 108 setup historis (64 dev / 44 uji). Per strategi sampel uji < 30 → UI menampilkan "Probabilitas belum tersedia — validasi historis belum memadai."

## 4. UI (Playwright, `scripts/ui-smoke.ts`)

8 halaman × 2 viewport (1440×900 dan 390×844), Supabase di-mock dengan data yang dihasilkan engine yang sama:
- Stylesheet termuat, **tanpa scroll horizontal**, **tanpa error JavaScript** di semua halaman. ✓
- Screenshot: `docs/screenshots/`.

Bug yang ditemukan & diperbaiki selama pengujian:
1. Tailwind v4 menolak `@apply` kelas kustom → CSS kosong. Diperbaiki dengan `@utility`.
2. Rekursi tak terbatas di realtime-js saat WebSocket gagal (`removeChannel` dipanggil di dalam callback status). Diperbaiki: penghapusan channel ditunda + abaikan callback channel lama; fallback polling tetap jalan.
3. Elemen grid meluber di mobile → `min-w-0`.

## Keterbatasan yang diketahui

- Uji end-to-end browser ke Supabase produksi tidak dapat dijalankan dari lingkungan build (jaringan dibatasi); diganti uji DB langsung + UI dengan mock.
- Data historis per strategi masih pendek (±2 minggu M5); probabilitas per strategi akan muncul otomatis setelah sampel uji ≥ 30.
