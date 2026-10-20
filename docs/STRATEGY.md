# Aturan Strategi, Validasi & Skor — GOLDMARKET

Semua aturan diimplementasikan di `src/core/` (dipakai identik oleh engine server, frontend, test, dan backtest). Angka di bawah adalah default `DEFAULT_ENGINE_CONFIG` (`src/core/config.ts`) dan dapat diubah lewat `engine_state.config` (JSON) tanpa deploy ulang.

## 1. Definisi pip & level

| Parameter | Default | Keterangan |
|---|---|---|
| Pip size | 0,10 USD/oz | 1 pip = perubahan harga 0,10 |
| Tick size | 0,01 | pembulatan harga |
| Desimal | 2 | |
| Contract size | 100 oz/lot | hanya untuk lot & P/L |
| SL / TP1 / TP2 / TP3 — setup **M15** | 50 / 50 / 100 / 150 pips | = 5 / 5 / 10 / 15 USD |
| SL / TP1 / TP2 / TP3 — setup **M30** | 70 / 70 / 140 / 210 pips | = 7 / 7 / 14 / 21 USD |
| SL / TP1 / TP2 / TP3 — setup H1 (tidak aktif sejak 19 Okt 2026) | 100 / 100 / 200 / 300 pips | = 10 / 10 / 20 / 30 USD |

Rencana per timeframe (`EngineConfig.planByTf`, `planFor`): pada harga emas ±$4.000, SL 50 pips ($5) lebih kecil dari ATR H1 hari kerja ($10–15), sehingga setup H1 hampir selalu gagal gate volatilitas. Karena itu H1 memakai rencana sendiri (keputusan pengguna, Okt 2026). Rencana tampil eksplisit di setiap setup.

BUY dari 3000,00 → SL 2995,00, TP1 3005,00, TP2 3010,00, TP3 3015,00. SELL kebalikannya (`levelsFromEntry`). Pip size, tick size, desimal, contract size terpisah dan dapat diatur per pengguna (Pengaturan → Spesifikasi broker).

Level **tidak pernah diubah diam-diam**: jika SL tetap tidak cocok dengan struktur/volatilitas, setup ditandai **tidak layak** beserta alasannya.

## 2. Pembagian timeframe

Sejak 19 Okt 2026 (permintaan pengguna: "pakai M15, M30 dan H1 saja") engine hanya membaca **M15, M30, H1** (`EngineConfig.biasTfs`, `pairs`, `analysisTfs`).

| TF | Peran |
|---|---|
| H1 + M30 | Bias tren utama (H1 = TF besar, M30 = pendukung) |
| M15 | Setup M15, konfirmasi candle M15 itu sendiri |
| M30 → M15 | Setup M30, konfirmasi candle M15 |
| M1, M5, H4, D1 | Informasi tambahan di chart (tidak dipakai sinyal) |

Gate volatilitas: bila TF konfirmasi = TF konteks (M15/M15) hanya batas ATR konteks yang dipakai; selain itu SL ≥ 0,8 × ATR TF konfirmasi.

**Bias per TF** (`analyzeTimeframe`): bullish bila struktur HH+HL **dan** close > EMA50 **dan** EMA20 > EMA50; bearish sebaliknya; jika struktur campuran tetapi EMA20/50/200 tersusun rapi dan kemiringan EMA50 > 0,3 ATR per 5 bar → ikut arah EMA; selain itu ranging.
Struktur = 2 swing high & 2 swing low terakhir (pivot fraktal 3-kiri/3-kanan; swing baru terkonfirmasi setelah 3 bar tertutup — tidak ada look-ahead).

**Bias utama**: H1 & M30 searah → kuat; M30 berarah & H1 ranging → moderat; konflik/M30 ranging → ranging. (Sebelum 19 Okt 2026: H4 + H1.) Supply/Demand reversal aktif saat **H1** ranging.

**Status analisis**: `Tidak ada setup valid` (data gagal validasi) → `Menunggu konfirmasi` (ada setup aktif belum terkonfirmasi) → `Bullish` / `Bearish` / `Ranging`.

## 3. Validasi data (syarat sebelum sinyal baru)

`assessQuality` memblokir sinyal baru bila: koneksi reconnecting/disconnected; pasar tutup; umur harga > 180 dtk; spread > 8 pips (khusus feed XAUUSD; spread instrumen proxy tidak dipakai); data < 60 bar pada H4/H1/M15/M5; candle terakhir tertinggal > 2 bar saat pasar buka; ada candle hilang dalam 30 bar terakhir (celah karena pasar tutup tidak dihitung). Setup lama tetap dipantau, tetapi sentuhan entry tidak dicatat bila harga basi.

Konfirmasi hanya memakai **candle tertutup** (`closedAsOf`). Harga intrabar dipakai untuk jarak ke entry, sentuhan entry, dan notifikasi.

## 4. Strategi

### Trend pullback (`detectTrendPullback`)
1. Bias utama searah arah setup; bias TF konteks tidak berlawanan; EMA20 di sisi tren dari EMA50.
2. Area = rentang EMA20–EMA50 (min 0,3 ATR), diperluas ke support/resistance terdekat (±0,5 ATR).
3. Harus sudah ada retracement ≥ 0,3 ATR dari swing impuls; harga ≤ 1,5 ATR dari area.
4. Invalidasi = swing berlawanan terdekat di luar area (≤ 3 ATR) ± 0,1 ATR. Tanpa swing → gagal syarat struktur.

### Breakout retest (`detectBreakoutRetest`)
1. Bias utama tidak berlawanan (boleh ranging).
2. Dalam 20 bar terakhir TF konteks ada candle body ≥ 0,5 ATR yang close menembus level ≥ 2 sentuhan sejauh ≥ 0,1 ATR (level dibangun hanya dari swing sebelum candle tersebut).
3. Tidak ada close kembali > 0,25 ATR ke dalam range setelahnya (breakout gagal).
4. Area retest = level −0,15/+0,25 ATR (BUY); invalidasi = level ∓ 0,6 ATR.

### Strategi riset (hanya backtest; live hanya bila terbukti & disetujui)
- **MSNR flip** (`detectMsnrFlip`, live sebagai **Eksperimen** sejak 20 Okt 2026): **hanya searah tren H1** (sempat dibuat dua arah 20 Okt pagi, dikembalikan ke searah tren 20 Okt sore atas permintaan pengguna; uji ulang 13–20 Okt: MSNR BUY melawan tren 2W/6L −170 pips). Level = swing high (BUY) / swing low (SELL) TF konteks dalam 30 bar terakhir yang ditembus close ≥ 0,1 ATR (resistance jadi support / sebaliknya) dan masih segar — belum ada close kembali maupun retest. Area retest L −0,15/+0,2 ATR, invalidasi L ∓ 0,5 ATR. SL/TP mengikuti rencana per TF. Beda dari Breakout retest: satu level swing (A/V), hanya retest pertama.
- **FVG retest** (`detectFvgRetest`, live sebagai **Eksperimen** sejak 20 Okt 2026, dua arah seperti MSNR flip): 3 candle a, b, c TF konteks dalam 20 bar terakhir; BUY bila c.low > a.high (celah 0,15–2 ATR) dan candle b dorongan naik (badan ≥ 0,8 ATR); masih segar = belum ada candle yang masuk celah dan belum ada close di bawah a.high (SELL cermin). Area entry = celah, invalidasi = tepi jauh celah ∓ 0,25 ATR. Sentuhan level 2 bila candle dorongan menembus swing terakhir (BOS), selain itu 1 (hanya skor). Melawan bias utama diizinkan: skor tren 0 (+5 bila H4 searah). SL/TP mengikuti rencana per TF.
- **20 Okt 2026 (sore)**: MSNR flip dikembalikan ke **searah tren H1 saja** (gate & pembatalan bias utama berlaku lagi); FVG retest tetap dua arah.
- **20 Okt 2026 (sore)**: setup yang belum kena entry dibatalkan (invalid, "peluang terlewat") bila harga sudah mencapai TP1 lebih dulu — atas permintaan pengguna; sebelumnya setup seperti SELL FVG 4.139,06 tetap menunggu sampai kedaluwarsa dan menahan antrean 1-sinyal.
- **20 Okt 2026 (siang)**: entry **stop dibuka lagi hanya untuk kasus "harga kembali ke area"** (`delivery.stopKinds = ["back_to_zone"]`); stop "di dalam area tanpa konfirmasi" (pemicu high/low candle terakhir — sumber 3 LOSS live semalam) tetap tidak dikirim. Uji ulang candle M15 nyata 30 Agu–19 Okt (spread 3 pips, BE, 24 jam, jam istirahat; tanpa aturan satu-sinyal): stop lama 89 sinyal 49W/40L +2.503 (+28/sinyal); V1 kembali-ke-area 17 sinyal 10W/7L +789 (+46/sinyal); pemicu close candle 37 sinyal +34/sinyal; close + searah tren 13 sinyal 9W/4L +52/sinyal; limit 534 sinyal +17/sinyal; market 95 sinyal +6/sinyal. Deteksi tidak berubah (backtest & hash tetap); hanya aturan pengiriman.
- **20 Okt 2026**: FVG retest ditambahkan sebagai Eksperimen (dua arah) atas permintaan pengguna. Uji ulang kasar di candle M15 nyata 13–20 Okt (tanpa spread, tanpa aturan satu-sinyal/jam istirahat, hanya limit/market): FVG BUY 5W/5L 0 pips, SELL 4W/2L +230; MSNR BUY 2W/6L −170, SELL 7W/5L +260; CRT BUY 5W/8L −110, SELL 2W/0L +100. Sampel kecil — penilaian tetap dari hasil live.
- **20 Okt 2026**: MSNR flip dibuat dua arah (BUY & SELL) tanpa filter tren H1; SL/TP/RR tidak berubah. CRT tetap seperti semula.
- **20 Okt 2026**: Breakout retest dan Liquidity sweep dihapus dari sinyal live atas permintaan pengguna (tetap disimulasikan di backtest). Strategi live: Supply/Demand reversal, CRT, MSNR flip (FVG retest menyusul 20 Okt).
- **CRT · Candle Range Theory** (`detectCrt`, live sebagai **Eksperimen** sejak 20 Okt 2026 atas permintaan pengguna): range = candle H1 tertutup terakhir (0,5–3× ATR H1). Candle konteks (M15/M30) sesudahnya menyapu low (BUY) / high (SELL) range ≥ 0,1 ATR lalu menutup kembali di dalam range, tanpa close di luar lagi sesudahnya. Area entry di ujung range (−0,1/+0,25 ATR), invalidasi di luar ujung sapuan, target alami sisi lain range (harus ≥ jarak TP1). SL/TP tetap mengikuti rencana per TF. Gate struktur standar (tidak melawan bias utama). Belum disimulasikan di backtest (versi backtest 12 bulan sedang berjalan).
- **Liquidity sweep** (`detectLiquiditySweep`): candle konteks menembus high/low hari sebelumnya, range Asia, atau swing lalu menutup kembali ke dalam; entry retest level yang direbut, invalidasi di luar ujung sweep. Live sebagai **Eksperimen** sejak 19 Okt 2026 atas permintaan pengguna (backtest XAU/USD ±5 minggu: +8,2 pips/trade varian C); SL/TP sama dengan rencana per TF, tidak diubah.
- **Supply/Demand reversal** (`detectSdReversal`): hanya saat **H4 ranging**; SELL di resistance (supply) ≥ 2 sentuhan di atas harga, BUY di support (demand) di bawah harga — boleh melawan bias H1. Area −0,25/+0,1 ATR (SELL), invalidasi = level ± 0,35 ATR (zona ditembus = ide pantulan batal; SL selalu di sisi yang benar). Aktif di live sebagai **eksperimen** (berlabel) sejak 19 Okt 2026 atas permintaan pengguna.

### Jenis entry (ditetapkan saat setup dibuat, tidak berubah)
- **Market**: candle konfirmasi TF konfirmasi sudah tertutup di area dan harga masih di area.
- **Limit**: harga belum masuk area → di tepi area terdekat.
- **Stop**: harga di dalam area tanpa konfirmasi → di atas high/bawah low candle konfirmasi terakhir (pemicu), atau harga di sisi seberang area → di tepi area.

Pola konfirmasi: engulfing, pin bar penolakan (wick ≥ 2× body, ≥ 55% range), candle momentum menutup melewati high/low sebelumnya.

## 5. Syarat wajib (gate) — semua harus lolos agar "layak"

| Gate | Aturan |
|---|---|
| Kualitas data | lolos §3 |
| Struktur | ada level invalidasi struktur & bias utama tidak berlawanan |
| SL vs invalidasi | invalidasi berada di antara entry dan SL (SL tetap tidak lebih sempit dari struktur). `invalidationTolPips` (default 0; live 5 sejak 19 Okt 2026) mengizinkan SL maks. N pips di dalam invalidasi; backtest meriset 5 pips dan mencatat `invSlackPips` per trade |
| Volatilitas | jarak SL ≥ 1,0 × ATR TF konfirmasi dan ≥ `minSlAtrContext` × ATR TF konteks (default 0,75; live 0,6 sejak 19 Okt 2026 atas permintaan pengguna — backtest meriset 0,6 dan mencatat `slAtrCtx` per trade) |
| Kelayakan risiko | RR TP2 setelah spread ≥ 1,5 dan spread ≤ 8 pips |

Setup gagal gate disimpan sebagai **Invalid / Tidak layak** dengan alasan, tanpa notifikasi.

## 6. Skor kualitas (0–100) — bukan probabilitas

| Komponen | Bobot | Penilaian |
|---|---|---|
| Keselarasan tren | 25 | H1&M30 searah 25 · M30 searah (H1 ranging) 18 · bias ranging 8 · berlawanan 0; **+5 bila H4 searah** (maks 25, sejak 20 Okt 2026) |
| Struktur & level | 25 | invalidasi jelas 10 + sentuhan level (1:3, 2:7, ≥3:10) + tidak ada level lawan sebelum TP1 5 |
| Konfirmasi candle | 20 | candle konfirmasi tertutup 20 |
| Momentum RSI 14 | 15 | BUY: RSI 45–68 → 10 (40–45 → 5), naik +5, > 75 → 0. SELL simetris |
| Volatilitas & biaya | 15 | SL 1–3 ATR konteks 8 (0,75–1: 4) + spread ≤ 10% SL 7 (≤ 20%: 3) |

**H4 = TF info** (`infoTf`, sejak 20 Okt 2026): dianalisis untuk ditampilkan dan bonus skor saja — bukan filter, tidak ikut cek kualitas data, dan tidak pernah menurunkan skor, jadi jumlah sinyal tidak berkurang. Tidak dipakai di backtest (hash versi tetap).

Engine menyimpan setup dengan skor ≥ 40; minimum skor tampilan/notifikasi per TF default 60 (M15, H1) dan dapat diatur pengguna. Skor 80/100 **tidak** berarti 80% peluang menang.

## 7. Identitas, dedupe, cooldown, kedaluwarsa

- `identity_key = strategi|arah|TF|jangkar` (jangkar = waktu swing impuls atau `level@waktu breakout`) — pola yang sama tidak pernah dibuat dua kali.
- Setup aktif strategi+arah+TF sama dengan entry < 30 pips → duplikat.
- Cooldown 2 bar TF konteks untuk pola serupa (entry < 60 pips); entry yang jauh berbeda tetap boleh — tidak ada jeda panjang tetap.
- Kedaluwarsa: pullback 16 bar, breakout 12 bar TF konteks.

## 8. Status peluang (terpisah dari jurnal)

`Mendekati area` → `Menunggu konfirmasi` (harga di area, belum ada candle konfirmasi) → `Entry tersentuh` (harga feed menyentuh entry; **bukan** berarti posisi dibuka) atau `Invalid` (close candle TF konfirmasi melewati invalidasi / bias utama berbalik / **peluang terlewat**: harga sudah mencapai TP1 sebelum entry tersentuh — sejak 20 Okt 2026, urutan dibaca dari candle M5; entry & TP1 di candle yang sama dihitung entry tersentuh; tidak berlaku untuk entry market) atau `Kedaluwarsa`. Setiap perubahan dicatat di `setup_events`.

## 9. Probabilitas historis (terpisah dari skor)

Backtest walk-forward berjalan **bertahap** (lihat §13): riwayat ±12 bulan PAXG/USDT dari Binance, hanya jam pasar emas, satu potongan 7 hari per run. Probabilitas dihitung dari seluruh trade simulasi:
- Pada tiap penutupan bar TF konteks, analisis hanya melihat candle tertutup ≤ t (`sliceClosed`).
- **P(entry)** = entry tersentuh sebelum kedaluwarsa/invalid. **P(TPk)** = TPk tersentuh sebelum SL setelah entry aktif.
- Biaya: spread/2 + slippage (+ komisi) digeser melawan posisi; TP harus menutup biaya.
- SL dan TP tersentuh di candle yang sama → **ambigu, dihitung SL** (konservatif) dan dilaporkan jumlahnya.
- Batas tahan 24 jam setelah entry (sama dengan pelacakan sinyal live); TP yang belum kena pada batas itu dihitung gagal.
- 60% awal data = pengembangan, 40% akhir = pengujian. Yang ditampilkan hanya data uji, dengan n, periode, dan interval Wilson 95%.
- Ditampilkan hanya bila n uji ≥ 30 (entry dan TP1). Jika tidak: “Probabilitas belum tersedia — validasi historis belum memadai.”

### Aturan pengiriman sinyal live (`src/core/delivery.ts`, `engine_state.config.delivery`)
Permintaan pengguna 19 Okt 2026, setelah volatilitas tiba-tiba saat pembukaan London. Hanya mengatur **pengiriman** — deteksi, SL/TP/RR, dan backtest tidak berubah; kandidat yang ditahan tidak disimpan sehingga bisa muncul lagi bila masih valid.
- **1 sinyal sekaligus**: tidak ada sinyal baru selama masih ada READY layak yang belum kena entry, atau sinyal berjalan yang belum TP1. Setelah TP1 (SL di BE), selesai, batal, atau kedaluwarsa, sinyal berikutnya boleh dikirim.
- **Entry stop dinonaktifkan** (20 Okt 2026): hasil live 19 Okt 1 WIN (+50, hanya TP1) / 3 LOSS (−190 pips); hanya entry **limit** dan **market** yang dikirim. Sinyal stop lama ditandai DIKECUALIKAN (tetap terlihat).
- Jendela 14.00–17.00 WIB (hanya stop/market, maks 1 sinyal/hari) sempat aktif 19 Okt malam lalu dibuka kembali atas permintaan pengguna; mekanisme `windows` tetap tersedia di config.

- **Jam istirahat 23.10–05.00 WIB** (20 Okt 2026): tidak ada sinyal baru. Setup yang belum kena entry dibatalkan (kedaluwarsa) saat jam istirahat mulai; sinyal yang sudah berjalan tetap dilacak sampai selesai. Saat jam istirahat mulai, engine mengirim **rekap hari itu** (05.00–23.10 WIB): jumlah READY, entry tersentuh, WIN/LOSS/timeout, total pips, dan yang masih berjalan — tanpa sinyal yang dikecualikan.

- **Reset tampilan harian 23.10 WIB**: Signal History di halaman Peluang dan lonceng notifikasi hanya menampilkan hari trading berjalan (plus sinyal yang masih berjalan). Tidak ada data yang dihapus — panel **Overall Performance** (Day/Week/Month/All) dan Jurnal → Sinyal tetap memuat semuanya. Day = sejak reset 23.10 WIB; Week = sejak Senin 00.00 WIB; Month = sejak tanggal 1 (WIB).

- **Trend pullback dihapus dari sinyal live** (20 Okt 2026, permintaan pengguna: tidak ada setup layak sejak 19 Okt). Tetap disimulasikan di backtest sebagai riset.

### Sinyal yang dikecualikan
Pengguna boleh mengecualikan sinyal dari statistik (`setups.excluded`, `excluded_reason`). Sinyal itu **tidak pernah dihapus**: tetap tampil di Riwayat Sinyal dengan badge DIKECUALIKAN dan alasannya, dan jumlahnya selalu ditampilkan di statistik.

## 10. Riwayat sinyal (hasil menurut feed) — terpisah dari jurnal

`evaluateOutcome` (`src/core/outcome.ts`) dijalankan engine tiap menit untuk setup layak yang entry-nya tersentuh:
- **Manajemen BE**: setelah TP1 tersentuh, SL dipindah ke entry (break-even) dan notifikasi "TP1 tersentuh — geser SL ke BE" dikirim (juga untuk TP2). Setup itu tidak lagi tampil sebagai peluang aktif (tidak berlaku untuk entry baru), hanya di Riwayat Sinyal.
- **WIN**: minimal TP1 tersentuh. Sinyal ditutup saat harga kembali ke entry (BE), TP3 tersentuh (bonus), atau batas waktu. Hasil = pips TP tertinggi yang tersentuh.
- TP pertama dan entry dalam candle M5 yang sama → urutan tidak diketahui; dihitung TP1 lalu BE (konservatif).
- **LOSS**: SL tersentuh sebelum TP1 (−pips SL).
- Waktu entry tersentuh = awal candle M5 pertama (setelah setup dibuat) yang menyentuh entry, atau waktu tick harga bila tick lebih dulu. Candle M15 Twelve Data baru masuk saat bar tutup, jadi tidak dipakai sebagai waktu.
- TP di candle M5 tempat entry tersentuh tidak dihitung (harga itu bisa terjadi sebelum entry); SL di candle itu tetap dihitung.
- TP yang sudah tercatat tidak pernah turun lagi.
- SL & TP dalam candle M5 yang sama → TP pada candle itu tidak dihitung (konservatif) dan ditandai ambigu.
- **TIMEOUT**: 24 jam (`SIGNAL_MAX_HOLD_HOURS`) tanpa TP1 maupun SL → hasil = pips harga terakhir.
- Spread/komisi/slippage tidak dikurangkan. Ini hasil level sinyal, bukan transaksi pengguna; jurnal tidak pernah diubah otomatis.
- Grade (A+ ≥ 80, A ≥ 70, B ≥ 60, C < 60) diturunkan dari skor kualitas, bukan probabilitas.

## 11. Notifikasi push (HP & desktop)

- Browser meminta izin hanya lewat tombol **Aktifkan notifikasi** (Live Opportunities, ikon lonceng, Pengaturan).
- Langganan Web Push disimpan di `push_subscriptions` (RLS per pengguna). Kunci VAPID dibuat otomatis oleh engine; kunci privat hanya di Supabase Vault.
- Engine mengirim push untuk: setup valid baru (READY, setiap setup yang dilacak; skor tertulis di isi notif — skor minimum per TF hanya menyaring daftar peluang), konfirmasi, entry tersentuh, invalid/kedaluwarsa, hasil sinyal, gangguan koneksi, dan harga mendekati entry (ambang per pengguna, default 20 pips, sekali per setup).
- Judul dibuat agar siap ditindaklanjuti **sebelum** zona tersentuh: setup baru → `🟢 READY BUY XAUUSD — M15` / `🔴 READY SELL XAUUSD — M15` (isi: zona, entry, SL, TP1–TP3, skor); mendekati entry → `READY … · X pips lagi`; lalu `✅ KONFIRMASI …`, `🎯 ZONA ENTRY TERSENTUH …`, `❌ SETUP BATAL …`, `⌛ SETUP KEDALUWARSA …`. Notifikasi bukan perintah eksekusi; website tidak mengirim order ke broker.
- iPhone/iPad: wajib iOS 16.4+ dan aplikasi dibuka dari ikon **Layar Utama** (Bagikan → Tambahkan ke Layar Utama). Android: Chrome/Edge/Firefox.
- Pengiriman tidak dijamin tepat waktu (jaringan, hemat baterai, kebijakan OS).

## 12. News AI (gratis, tanpa API key)

- **Fokus topik: hanya FOMC, NFP, CPI, PPI** (permintaan pengguna). Berlaku untuk berita, kalender, dan notifikasi.
  - Berita: `newsTopic()` — FOMC (FOMC, federal funds rate, dot plot, "Fed holds/cuts/raises/minutes/decision"), NFP (non-farm payrolls, payrolls, jobs report; laporan **ADP bukan NFP**), CPI (CPI, consumer prices, inflation report/data), PPI (PPI, producer prices). Berita yang jelas tentang negara lain (mis. CPI Inggris) tidak diambil.
  - Kalender: `calendarTopic()` — FOMC = `Federal Funds Rate`, `FOMC Statement`, `FOMC Press Conference`, `FOMC Meeting Minutes`, `FOMC Economic Projections` (pidato anggota FOMC tidak termasuk), `Non-Farm Employment Change` + `Unemployment Rate` + `Average Hourly Earnings` (paket laporan NFP yang rilis bersamaan; `ADP Non-Farm` dikecualikan), `CPI`/`Core CPI`, `PPI`/`Core PPI`. Event di luar keempat topik tidak disimpan.
  - Peringatan push berlaku untuk semua event keempat topik (apa pun label dampaknya di sumber), judul `⚠️ NEWS CPI 30 menit lagi: CPI m/m (USD)`.

- **Sumber berita** (RSS publik, judul + tautan saja, artikel tidak disalin): Google News (pencarian gold/XAUUSD/Fed), Investing.com (komoditas, ekonomi, forex), Federal Reserve (rilis pers resmi), CNBC Economy, MarketWatch. Engine mode `news` berjalan tiap 15 menit; sumber yang gagal (mis. HTTP 503) dilewati dan dicatat di `engine_runs.stats.feeds`.
- **Relevansi**: gerbang kata kunci (gold, XAU, Fed, FOMC, dollar, yields, CPI, NFP, PCE, inflation, …) + skor kemiripan embedding model `gte-small` bawaan Supabase Edge Runtime (gratis; disimpan di `news_items.relevance`; filter opsional via env `NEWS_MIN_RELEVANCE`, default 0 = tidak memfilter). Bila model tidak tersedia, cukup kata kunci.
- **Label dampak ke emas** (`src/core/news.ts`, `classifyGoldImpact`) — aturan transparan, tiap aturan dihitung sekali:
  - Mendukung emas (+2): pemangkasan suku bunga/dovish, USD melemah, imbal hasil turun / bond rally, inflasi melandai, data AS lemah, safe haven/geopolitik/krisis, pembelian bank sentral / arus masuk ETF.
  - Menekan emas (−2): kenaikan suku bunga/hawkish/higher for longer, USD menguat, imbal hasil naik, inflasi panas, data AS kuat, ketegangan mereda (ceasefire/trade deal).
  - Laporan harga emas naik/turun: ±1.
  - Negasi sebelum frasa ("rules out rate cuts", "delays rate cut") membalik arah aturan tersebut dan ditulis di alasan.
  - Label = tanda jumlah skor; skor 0 → Netral. Bila ada faktor dua arah → ditandai "faktor bertentangan".
  - Keyakinan hanya **rendah** atau **sedang** (≥ 2 pendorong searah tanpa konflik). Tidak pernah ditampilkan sebagai persentase/probabilitas.
- **Keterbatasan jujur**: tanpa LLM generatif tidak ada ringkasan bahasa Indonesia baru; judul tampil dalam bahasa asli + penjelasan Indonesia dari templat aturan. Aturan kata kunci bisa keliru membaca konteks (sarkasme, berita non-AS); baca sumbernya.
- **Kalender ekonomi**: feed mingguan publik ForexFactory (`ff_calendar_thisweek.json`), diambil maksimal sekali per jam; hanya USD dampak High & Medium. Feed ini **tidak memuat angka actual** — UI hanya menampilkan forecast/previous. Jadwal minggu depan baru tersedia saat sumber memperbarui kalender di awal minggu.
- **Peringatan sebelum news besar**: event USD High dalam ambang menit per pengguna (`user_settings.news_alert_minutes`, default 30, 5–240) → push `⚠️ NEWS BESAR {N} menit lagi: {judul} (USD)` sekali per event per pengguna (dedupe `user_alerts`, kunci `news:<event>`); lonceng in-app 30 menit sebelumnya. Bisa dimatikan di Pengaturan → jenis notifikasi "News besar".

## 13. Kebersihan data & backtest manajemen posisi

**Jam pasar emas.** PAXG diperdagangkan 24/7, sedangkan emas tutup di akhir pekan (Jumat 17:00 – Minggu 18:00 New York) dan jeda harian 17:00–18:00 New York. Bar di luar jam itu bukan harga emas, jadi `marketHoursOnly()` membuangnya sebelum disimpan dan sebelum backtest. Bar lama yang sempat tersimpan dibersihkan sekali oleh engine (`engine_state.maintenance.offhours_purged_v1`).

**Sumber candle live.** Bila `TWELVEDATA_API_KEY` diset, analisis live memakai candle XAU/USD Twelve Data (`td_hybrid`); tanpa key, candle PAXG digeser basis (`spot_hybrid`). Backtest memakai riwayat XAU/USD Twelve Data bila key ada (4 kredit per potongan, dijadwalkan menit :07 dan :37 agar kuota gratis cukup), selain itu PAXG Binance. Sumber data ikut menentukan versi strategi; laporan dan probabilitas versi lama tetap tampil sampai semua potongan versi baru lengkap.

**Backtest bertahap.**
- Mode engine `backtest` berjalan tiap 10 menit dan menghitung satu potongan 7 hari (mulai Senin 00:00 UTC). Potongan diambil dari terbaru ke terlama sampai ±12 bulan (`BACKTEST_MONTHS`).
- Data riwayat diambil langsung dari Binance dengan pemanasan H4 60 hari, H1 16 hari, M15 5 hari, dan M5 4 hari.
- Trade disimpan di `backtest_trades`; status potongan di `backtest_chunks`.
- `strategy_version` adalah hash dari konfigurasi strategi + versi kode. Bila strategi berubah, semua potongan dihitung ulang dan data versi lama dihapus.
- Potongan berjalan diperbarui tiap 6 jam; potongan yang sudah lewat 1 hari setelah akhirnya dianggap final.

**Manajemen posisi.** Setiap setup yang entry-nya tersentuh disimulasikan dengan tiga cara. Hasilnya dalam pips per trade, biaya sudah termasuk.

| Varian | Aturan |
|---|---|
| A — TP1 penuh | Seluruh posisi keluar di TP1 atau SL. |
| B — Bertahap 1/3, SL tetap | 1/3 posisi keluar di TP1, TP2, TP3; sisa kena SL. |
| C — Bertahap 1/3 + BE setelah TP1 | Seperti B, tetapi setelah TP1 SL sisa posisi pindah ke entry. BE aktif mulai bar berikutnya, karena urutan di dalam bar tidak diketahui; keluar di BE = rugi sebesar biaya. |
| D — TP cepat 0,4R | Seluruh posisi keluar di 0,4R (M15 ±20 pips, H1 ±40 pips) atau SL. |
| E — TP cepat 0,6R | Seluruh posisi keluar di 0,6R (M15 ±30 pips, H1 ±60 pips) atau SL. |
| F — 1/2 di 0,6R + BE, sisa ke TP2 | Setengah posisi keluar di 0,6R, lalu SL sisanya pindah ke entry; sisa menuju TP2. |

- Biaya: SL = jarak SL + biaya; TP = jarak TP penuh (TP harus menutup biaya). SL dan TP dalam satu candle dihitung SL.
- Posisi yang lewat 24 jam ditutup di close terakhir. Trade yang datanya habis sebelum tuntas tidak dihitung.

**Ringkasan** (`summarizeTrades`). Dihitung per grup (semua, strategi|TF, sesi, arah) dan per varian, dengan pemisahan kronologis 60% pengembangan / 40% uji (headline = uji):
- n;
- win rate (Wilson 95%);
- ekspektasi pips ± 1,96·SE dan dalam R;
- profit factor;
- max drawdown;
- total pips.

Kesimpulan di UI disusun otomatis dan jujur:
- "belum memadai" bila n < 30;
- "belum terbukti punya edge" bila tidak ada varian yang positif;
- "positif tapi belum signifikan" bila intervalnya mencakup nol.

Kesimpulan ini bukan perintah. Jurnal tetap manual.

**Win rate tinggi tanpa mengurangi jumlah sinyal.** Pengguna ingin win rate ≥75–80%, tetapi tidak mau sinyal dipangkas oleh filter ketat. Karena itu win rate dinaikkan lewat **TP lebih dekat** (varian D–F), bukan dengan menyaring setup.

Konsekuensinya jelas: dengan SL ±54 pips setelah biaya, win rate minimum untuk impas adalah 52% (TP 50), 64% (TP 30), 73% (TP 20), dan 78% (TP 15). Win rate tinggi hanya berguna bila ekspektasinya tetap positif.

`pickVariant(report, 0.75)` bekerja dalam dua langkah:
1. **Memilih dari data pengembangan:** varian dengan ekspektasi tertinggi di antara varian yang punya WR ≥ 75%, ekspektasi > 0, dan n ≥ 30.
2. **Membuktikan di data uji**, dengan putusan:
   - **terbukti:** WR ≥ target dan interval ekspektasi > 0;
   - **positif:** masih positif tapi belum memenuhi target atau belum signifikan;
   - **gagal:** ekspektasi ≤ 0 — kemungkinan overfitting, jangan dipakai;
   - **sampel kurang:** n uji belum cukup.

Data uji tidak pernah dipakai untuk memilih.

**Blackout news.** Engine tidak membuat setup baru ±30 menit di sekitar rilis FOMC/NFP/CPI/PPI (`newsBlackoutMin`, `newsBlackoutAt`):
- setup yang sudah ada tetap dipantau;
- alasan penahanan tampil di Dashboard (“Sinyal baru dihentikan”);
- jumlah sinyal yang hilang hanya beberapa per minggu.

Aturan ini belum bisa divalidasi di backtest karena kalender historis tidak tersedia gratis; ini aturan manajemen risiko, bukan klaim peningkatan win rate.
