"use client";

import { useMemo, useState } from "react";
import { AppShell } from "@/components/Shell";
import { Card, Empty, Stat, ago, cx, useNow } from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { useEconEvents, useEventPredictions, useNews, useUsdBias, type EconEventRow, type EventPredictionRow, type KeyTopic, type NewsRow, type UsdBiasRow } from "@/lib/market";
import { EventBiasChip, NextEvent, UsdBiasCard, countdown, dayKey, hm, releaseOf } from "@/components/NextEvent";
import { eventBias } from "@/core/eventBias";

export default function Page() {
  return (
    <AppShell>
      <NewsPage />
    </AppShell>
  );
}

const TOPICS: KeyTopic[] = ["FOMC", "NFP", "CPI", "PPI"];
const TOPIC_DESC: Record<KeyTopic, string> = {
  FOMC: "Keputusan suku bunga The Fed",
  NFP: "Laporan tenaga kerja AS (Non-Farm Payrolls)",
  CPI: "Inflasi konsumen AS",
  PPI: "Inflasi produsen AS",
};

function TopicChip({ topic }: { topic: KeyTopic | null }) {
  if (!topic) return null;
  return (
    <span className="chip border-gold/50 bg-gold/10 font-bold text-gold" title={TOPIC_DESC[topic]}>
      {topic}
    </span>
  );
}

const LABEL: Record<NewsRow["label"], { text: string; icon: string; cls: string }> = {
  bullish: { text: "BUY", icon: "▲", cls: "border-buy/50 bg-buy/10 text-buy" },
  bearish: { text: "SELL", icon: "▼", cls: "border-sell/50 bg-sell/10 text-sell" },
  neutral: { text: "Netral", icon: "●", cls: "border-muted/40 bg-muted/10 text-muted" },
};
// kolom confidence menyimpan kekuatan bias
const STRENGTH: Record<NewsRow["confidence"], { text: string; w: number }> = { rendah: { text: "lemah", w: 1 }, sedang: { text: "sedang", w: 2 }, tinggi: { text: "kuat", w: 3 } };

/** Judul sindikasi yang mirip (beda sufiks sumber) dihitung sekali. */
const storyKey = (t: string) => t.toLowerCase().replace(/\s[|–-]\s.*$/, "").replace(/[^a-z0-9 ]/g, "").split(/\s+/).slice(0, 8).join(" ");

/** Rekap arah berita 24 jam: Σ arah × kekuatan (lemah 1, sedang 2, kuat 3). */
function newsBias(rows: NewsRow[]) {
  const seen = new Set<string>();
  let buy = 0;
  let sell = 0;
  let net = 0;
  for (const n of rows) {
    if (n.label === "neutral") continue;
    const k = storyKey(n.title);
    if (seen.has(k)) continue;
    seen.add(k);
    const w = STRENGTH[n.confidence]?.w ?? 1;
    if (n.label === "bullish") {
      buy++;
      net += w;
    } else {
      sell++;
      net -= w;
    }
  }
  const side = net >= 3 ? "BUY" : net <= -3 ? "SELL" : "CAMPURAN";
  return { buy, sell, net, side } as const;
}

function NewsPage() {
  const { settings } = useAuth();
  const tz = settings?.display_tz ?? "Asia/Jakarta";
  const now = useNow(1000);
  const { data: news, error: newsErr } = useNews();
  const { data: events, error: evErr } = useEconEvents();
  const { data: usd } = useUsdBias();
  const [tab, setTab] = useState<"news" | "calendar" | "history">("news");
  const [filter, setFilter] = useState<"all" | KeyTopic>("all");
  const [onlyBias, setOnlyBias] = useState(false);

  const next = useMemo(() => (events ?? []).find((e) => e.topic && Date.parse(e.time_at) > now), [events, now]);
  const day = useMemo(() => {
    const recent = (news ?? []).filter((n) => now - Date.parse(n.published_at ?? n.created_at) <= 86400000);
    return { ...newsBias(recent), neutral: recent.filter((n) => n.label === "neutral").length };
  }, [news, now]);
  const shown = (news ?? []).filter((n) => (filter === "all" || n.topic === filter) && (!onlyBias || n.label !== "neutral"));

  return (
    <div className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-bold">
          News AI
          <span className="chip border-gold/40 bg-gold/10 text-gold">
            <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-current" /> otomatis
          </span>
        </h1>
        <p className="text-sm text-muted">Fokus hanya <b className="text-gold">FOMC · NFP · CPI · PPI</b> — berita, kalender, dan peringatan sebelum rilis. Diperbarui tiap 15 menit dari sumber gratis.</p>
      </div>

      <div className="rounded-xl border border-warn/40 bg-warn/5 p-3 text-xs text-warn">
        Label BUY/SELL XAUUSD adalah <b>arah fundamental menurut judul berita</b>, dibaca otomatis berbasis aturan (pendorong harga emas: suku bunga Fed, USD &amp; pasangan mata uang, imbal hasil, inflasi, data AS, geopolitik), lengkap dengan frasa pemicunya. Ini <b>bukan sinyal entry</b>: uji 20–27 Okt 2026 (87 judul berarah) menunjukkan arah ini <b>tidak memprediksi</b> gerak XAU 1–4 jam sesudah berita terbit (±52% benar, setara lempar koin) — berita sering terbit setelah harga bergerak. Pakai sebagai konteks, bukan pengganti setup. Bukan saran investasi.
      </div>

      <UsdBiasCard b={usd} now={now} />

      <NextEvent ev={next ?? null} now={now} tz={tz} events={events} news={news} usd={usd} />

      <div className="flex gap-2">
        {(["news", "calendar", "history"] as const).map((t) => (
          <button key={t} className={cx("rounded-xl border px-4 py-2 text-sm font-semibold", tab === t ? "border-gold/60 bg-gold/10 text-gold" : "border-line text-muted hover:text-ink")} onClick={() => setTab(t)}>
            {t === "news" ? "Berita" : t === "calendar" ? "Kalender" : "Riwayat Prediksi"}
          </button>
        ))}
      </div>

      {tab === "news" ? (
        <Card
          title="Berita FOMC · NFP · CPI · PPI"
          action={
            <div className="flex flex-wrap justify-end gap-1">
              {(["all", ...TOPICS] as const).map((f) => (
                <button key={f} className={cx("chip", filter === f ? "border-gold/60 bg-gold/10 text-gold" : "border-line text-muted")} onClick={() => setFilter(f)} title={f === "all" ? undefined : TOPIC_DESC[f]}>
                  {f === "all" ? "Semua" : f}
                </button>
              ))}
            </div>
          }
        >
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-line/70 bg-surface-2/50 p-3 text-xs">
            <span className="text-muted">Arah berita 24 jam:</span>
            <span className={cx("chip font-bold", day.side === "BUY" ? LABEL.bullish.cls : day.side === "SELL" ? LABEL.bearish.cls : LABEL.neutral.cls)}>
              {day.side === "BUY" ? "▲ condong BUY" : day.side === "SELL" ? "▼ condong SELL" : "● campuran"}
            </span>
            <span className="text-muted">
              <span className="text-buy">{day.buy} BUY</span> · <span className="text-sell">{day.sell} SELL</span> · {day.neutral} netral · skor {day.net > 0 ? "+" : ""}
              {day.net} (lemah 1, sedang 2, kuat 3; judul sindikasi dihitung sekali)
            </span>
            <button className={cx("chip ml-auto", onlyBias ? "border-gold/60 bg-gold/10 text-gold" : "border-line text-muted")} onClick={() => setOnlyBias((v) => !v)}>
              {onlyBias ? "✓ " : ""}hanya BUY/SELL
            </button>
          </div>
          {newsErr && <p className="mb-2 text-xs text-sell">Gagal memuat berita: {newsErr}</p>}
          {news == null ? (
            <p className="text-sm text-muted">Memuat berita…</p>
          ) : shown.length === 0 ? (
            <Empty title="Belum ada berita untuk topik ini">Hanya berita FOMC, NFP, CPI, dan PPI yang ditampilkan. Berita biasanya ramai menjelang dan sesudah jadwal rilisnya (lihat tab Kalender).</Empty>
          ) : (
            <ul className="space-y-2">
              {shown.map((n) => (
                <NewsCard key={n.id} n={n} now={now} />
              ))}
            </ul>
          )}
        </Card>
      ) : tab === "calendar" ? (
        <Calendar events={events} news={news} usd={usd} error={evErr} now={now} tz={tz} />
      ) : (
        <PredictionHistory now={now} tz={tz} />
      )}
    </div>
  );
}

function NewsCard({ n, now }: { n: NewsRow; now: number }) {
  const l = LABEL[n.label];
  return (
    <li className="fade-in rounded-xl border border-line/70 bg-surface-2/50 p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
        <div className="flex shrink-0 flex-wrap gap-1 self-start sm:w-24 sm:flex-col sm:items-start">
          <TopicChip topic={n.topic} />
          <span className={cx("chip font-bold", l.cls)} title="Arah fundamental XAUUSD menurut judul (berbasis aturan), bukan sinyal entry">
            <span className={cx(n.label !== "neutral" && "pulse-dot")}>{l.icon}</span> {l.text}
          </span>
          {n.label !== "neutral" && <span className="chip border-line text-[10px] text-muted">bias {STRENGTH[n.confidence]?.text ?? n.confidence}</span>}
        </div>
        <div className="min-w-0 flex-1">
          <a href={n.link} target="_blank" rel="noopener noreferrer nofollow" className="block break-words font-semibold leading-snug text-ink hover:text-gold">
            {n.title}
          </a>
          <div className="mt-0.5 text-[11px] text-muted">
            {n.source} · {ago(n.published_at ?? n.created_at, now)}
          </div>
          {n.snippet && <p className="mt-1 break-words text-xs text-muted">{n.snippet}</p>}
          <p className="mt-2 break-words text-xs text-ink/90">{n.explanation}</p>
          {n.conflict && (
            <div className="mt-2 flex flex-wrap gap-1">
              <span className="chip border-warn/40 text-[10px] text-warn">ada faktor berlawanan</span>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function Calendar({ events, news, usd, error, now, tz }: { events: EconEventRow[] | null; news: NewsRow[] | null; usd: UsdBiasRow | null; error: string | null; now: number; tz: string }) {
  const usdFresh = usd && now - Date.parse(usd.computed_at) <= 3600_000 ? { usd: usd.usd_side, strength: usd.strength } : null;
  // satu perkiraan arah per paket rilis (waktu & topik sama), ditampilkan di baris pertamanya
  const firstOfRelease = new Set<string>();
  const seen = new Set<string>();
  for (const e of events ?? []) {
    const k = `${e.time_at}|${e.topic}`;
    if (!seen.has(k)) firstOfRelease.add(e.event_key);
    seen.add(k);
  }
  const groups = useMemo(() => {
    const m = new Map<string, EconEventRow[]>();
    for (const e of events ?? []) {
      const k = dayKey(e.time_at, tz);
      m.set(k, [...(m.get(k) ?? []), e]);
    }
    return [...m.entries()];
  }, [events, tz]);

  return (
    <Card title="Jadwal FOMC · NFP · CPI · PPI (USD)">
      <p className="mb-3 text-xs text-muted">
        Sumber: ForexFactory (feed mingguan publik), waktu dalam {tz}. Feed ini hanya memuat <b>forecast</b> dan <b>previous</b> — angka <b>actual belum tersedia di sumber</b>, jadi tidak ditampilkan.
      </p>
      {error && <p className="mb-2 text-xs text-sell">Gagal memuat kalender: {error}</p>}
      {events == null ? (
        <p className="text-sm text-muted">Memuat kalender…</p>
      ) : groups.length === 0 ? (
        <Empty title="Tidak ada jadwal FOMC/NFP/CPI/PPI">Tidak ada rilis keempat topik ini di kalender periode ini. Jadwal minggu depan muncul otomatis saat sumber memperbarui kalender (awal minggu).</Empty>
      ) : (
        <div className="space-y-4">
          {groups.map(([day, list]) => (
            <div key={day}>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-gold">{day}</div>
              <ul className="divide-y divide-line/60 rounded-xl border border-line/70">
                {list.map((e) => {
                  const ms = Date.parse(e.time_at) - now;
                  return (
                    <li key={e.event_key} className={cx("flex flex-wrap items-center gap-x-3 gap-y-1 p-3 text-sm", ms <= 0 && "opacity-60")}>
                      <span className="num w-12 shrink-0 text-muted">{hm(e.time_at, tz)}</span>
                      <TopicChip topic={e.topic} />
                      <span className="min-w-0 flex-1 break-words font-medium">{e.title}</span>
                      <span className="num text-xs text-muted">F {e.forecast ?? "—"} · P {e.previous ?? "—"}</span>
                      <span className={cx("num w-full text-xs sm:w-24 sm:text-right", ms > 0 ? "text-gold" : "text-muted")}>{countdown(ms)}</span>
                      {ms > 0 && firstOfRelease.has(e.event_key) && (
                        <span className="flex w-full flex-wrap items-center gap-2 text-xs text-muted">
                          Perkiraan arah: <EventBiasChip b={eventBias(releaseOf(e, events), news ?? [], now, usdFresh)} />
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

const MOVE_KEYS = [
  { k: "15m", label: "15 mnt" },
  { k: "60m", label: "1 jam" },
  { k: "240m", label: "4 jam" },
] as const;

function MoveCell({ move, hit }: { move: number | null; hit: boolean | null }) {
  if (move == null) return <span className="text-muted">—</span>;
  return (
    <span className={cx("num", hit === true ? "text-buy" : hit === false ? "text-sell" : "text-muted")}>
      {move > 0 ? "+" : ""}
      {move.toFixed(1)} {hit === true ? "✓" : hit === false ? "✗" : ""}
    </span>
  );
}

/** Riwayat prediksi arah rilis vs reaksi XAU sesudah rilis — untuk menilai apakah perkiraannya berguna. */
function PredictionHistory({ now, tz }: { now: number; tz: string }) {
  const { data: rows, error } = useEventPredictions();
  const stats = useMemo(() => {
    const done = (rows ?? []).filter((r) => r.status === "done");
    const acc = (k: "hit_15m" | "hit_60m" | "hit_240m") => {
      const judged = done.filter((r) => r[k] != null);
      const ok = judged.filter((r) => r[k]).length;
      return { n: judged.length, ok, pct: judged.length ? (100 * ok) / judged.length : null };
    };
    const live = done.filter((r) => !r.backfilled);
    return { done: done.length, neutral: done.filter((r) => r.side === "NETRAL").length, a15: acc("hit_15m"), a60: acc("hit_60m"), a240: acc("hit_240m"), live: live.length };
  }, [rows]);
  const pct = (a: { n: number; ok: number; pct: number | null }) => (a.pct == null ? "—" : `${a.pct.toFixed(0)}%`);

  return (
    <Card title="Riwayat prediksi arah rilis (FOMC · NFP · CPI · PPI)">
      <p className="mb-3 text-xs text-muted">
        Prediksi diperbarui tiap 15 menit sampai waktu rilis lalu <b>dibekukan</b>; 4 jam sesudah rilis dinilai dari gerak XAU/USD (harga sebelum rilis → 15 menit, 1 jam, 4 jam). ✓ = harga bergerak searah prediksi, ✗ = berlawanan. NETRAL tidak dinilai. Penilaian utama: 1 jam.
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Rilis dinilai" value={stats.done} sub={`${stats.neutral} netral · ${stats.live} prediksi live`} />
        <Stat label="Benar 15 mnt" value={pct(stats.a15)} sub={`${stats.a15.ok}/${stats.a15.n}`} />
        <Stat label="Benar 1 jam" value={pct(stats.a60)} sub={`${stats.a60.ok}/${stats.a60.n}`} tone="gold" />
        <Stat label="Benar 4 jam" value={pct(stats.a240)} sub={`${stats.a240.ok}/${stats.a240.n}`} />
      </div>
      <p className="mt-2 text-xs text-muted">
        Butuh puluhan rilis (±4–6 per bulan) sebelum angka ini berarti; di bawah ±60% dari 20+ rilis = tidak lebih baik dari lempar koin. Rilis bertanda <i>dihitung ulang</i> dibuat sesudah rilis dari data yang tersedia sebelum rilis (rilis sebelum fitur ini ada).
      </p>
      {error && <p className="mt-2 text-xs text-sell">Gagal memuat riwayat: {error}</p>}
      {rows == null ? (
        <p className="mt-3 text-sm text-muted">Memuat…</p>
      ) : rows.length === 0 ? (
        <Empty title="Belum ada riwayat">Riwayat mulai terisi pada run berita berikutnya (tiap 15 menit).</Empty>
      ) : (
        <ul className="mt-3 divide-y divide-line/60 rounded-xl border border-line/70">
          {rows.map((r) => {
            const upcoming = Date.parse(r.time_at) > now;
            return (
              <li key={r.release_key} className="space-y-1 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="num text-xs text-muted">
                    {dayKey(r.time_at, tz)} · {hm(r.time_at, tz)}
                  </span>
                  <TopicChip topic={r.topic} />
                  {r.usd_side && r.usd_side !== "NETRAL" && <span className={cx("text-xs font-semibold", r.usd_side === "BULLISH" ? "text-buy" : "text-sell")}>{r.usd_side === "BULLISH" ? "Bullish USD" : "Bearish USD"} →</span>}
                  <EventBiasChip b={{ side: r.side, usd: r.usd_side ?? "NETRAL", strength: r.strength, score: r.score, reasons: r.reasons, scenario: r.scenario }} />
                  {r.backfilled && <span className="chip border-line text-[10px] text-muted">dihitung ulang</span>}
                  <span className="ml-auto text-xs text-muted">
                    {upcoming ? `rilis ${countdown(Date.parse(r.time_at) - now)} lagi` : r.status === "pending" ? "menunggu 4 jam sesudah rilis" : r.status === "no_data" ? "data harga tidak tersedia" : `harga sebelum rilis ${r.base_price?.toFixed(2)}`}
                  </span>
                </div>
                <div className="break-words text-xs text-muted">{r.events.map((e) => `${e.title} (F ${e.forecast ?? "—"} · P ${e.previous ?? "—"})`).join(" · ")}</div>
                {r.status === "done" && (
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                    {MOVE_KEYS.map(({ k, label }) => (
                      <span key={k}>
                        <span className="text-muted">{label}: </span>
                        <MoveCell move={r[`move_${k}`]} hit={r[`hit_${k}`]} />
                      </span>
                    ))}
                  </div>
                )}
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted">Alasan prediksi</summary>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5">
                    {r.reasons.map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                  </ul>
                  {r.scenario && <p className="mt-1">{r.scenario}</p>}
                  <p className="mt-1 text-muted">Dibekukan {ago(r.predicted_at, now)}.</p>
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
