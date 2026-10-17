"use client";

import { useMemo, useState } from "react";
import { AppShell } from "@/components/Shell";
import { Card, Empty, ago, cx, useNow } from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { useEconEvents, useNews, type EconEventRow, type KeyTopic, type NewsRow } from "@/lib/market";
import { NextEvent, countdown, dayKey, hm } from "@/components/NextEvent";

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
  bullish: { text: "Bullish", icon: "▲", cls: "border-buy/50 bg-buy/10 text-buy" },
  bearish: { text: "Bearish", icon: "▼", cls: "border-sell/50 bg-sell/10 text-sell" },
  neutral: { text: "Netral", icon: "●", cls: "border-muted/40 bg-muted/10 text-muted" },
};

function NewsPage() {
  const { settings } = useAuth();
  const tz = settings?.display_tz ?? "Asia/Jakarta";
  const now = useNow(1000);
  const { data: news, error: newsErr } = useNews();
  const { data: events, error: evErr } = useEconEvents();
  const [tab, setTab] = useState<"news" | "calendar">("news");
  const [filter, setFilter] = useState<"all" | KeyTopic>("all");

  const next = useMemo(() => (events ?? []).find((e) => e.topic && Date.parse(e.time_at) > now), [events, now]);
  const day = useMemo(() => {
    const recent = (news ?? []).filter((n) => now - Date.parse(n.published_at ?? n.created_at) <= 86400000);
    return { bullish: recent.filter((n) => n.label === "bullish").length, bearish: recent.filter((n) => n.label === "bearish").length, neutral: recent.filter((n) => n.label === "neutral").length };
  }, [news, now]);
  const shown = (news ?? []).filter((n) => filter === "all" || n.topic === filter);

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
        Label Bullish/Bearish adalah <b>analisis otomatis berbasis aturan</b> (pendorong harga emas: suku bunga Fed, USD, imbal hasil, inflasi, data AS, geopolitik) — bukan saran investasi, bukan sinyal, dan bukan probabilitas. Judul ditampilkan dalam bahasa aslinya; baca sumber untuk konteks lengkap.
      </div>

      <NextEvent ev={next ?? null} now={now} tz={tz} />

      <div className="flex gap-2">
        {(["news", "calendar"] as const).map((t) => (
          <button key={t} className={cx("rounded-xl border px-4 py-2 text-sm font-semibold", tab === t ? "border-gold/60 bg-gold/10 text-gold" : "border-line text-muted hover:text-ink")} onClick={() => setTab(t)}>
            {t === "news" ? "Berita" : "Kalender"}
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
          <p className="mb-3 text-xs text-muted">
            24 jam terakhir: <span className="text-buy">{day.bullish} bullish</span> · <span className="text-sell">{day.bearish} bearish</span> · {day.neutral} netral (hitungan judul, bukan prediksi arah).
          </p>
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
      ) : (
        <Calendar events={events} error={evErr} now={now} tz={tz} />
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
          <span className={cx("chip font-bold", l.cls)} title="Dampak menurut aturan, untuk XAUUSD">
            <span className={cx(n.label !== "neutral" && "pulse-dot")}>{l.icon}</span> {l.text}
          </span>
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
          <div className="mt-2 flex flex-wrap gap-1">
            <span className="chip border-line text-[10px] text-muted">keyakinan {n.confidence}</span>
            {n.conflict && <span className="chip border-warn/40 text-[10px] text-warn">faktor bertentangan</span>}
          </div>
        </div>
      </div>
    </li>
  );
}

function Calendar({ events, error, now, tz }: { events: EconEventRow[] | null; error: string | null; now: number; tz: string }) {
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
