/**
 * Perkiraan arah XAUUSD SEBELUM rilis FOMC/NFP/CPI/PPI (7 Nov 2026) — berbasis aturan, bukan model AI.
 *
 * Dua bahan yang tersedia sebelum angka actual keluar:
 *  1. Ekspektasi: forecast dibanding previous (feed ForexFactory). Contoh: forecast CPI > previous →
 *     pasar memperkirakan inflasi naik → Fed cenderung ketat → menekan emas (SELL).
 *  2. Nada berita topik yang sama 72 jam terakhir (label BUY/SELL News AI, bobot kekuatan).
 * Kekuatan maksimal "sedang": forecast sudah diperhitungkan pasar, gerak besar datang dari SELISIH
 * actual vs forecast, jadi skenario rilis selalu ditampilkan di samping perkiraan.
 */
import { calendarTopic, type KeyTopic } from "./news.ts";

export type EventBiasSide = "BUY" | "SELL" | "NETRAL";

export interface EventLike {
  title: string;
  time_at: string;
  forecast: string | null;
  previous: string | null;
}

export interface NewsLike {
  label: "bullish" | "bearish" | "neutral";
  confidence: "rendah" | "sedang" | "tinggi";
  topic: string | null;
  published_at: string | null;
  created_at: string;
}

export interface EventBias {
  side: EventBiasSide;
  strength: "lemah" | "sedang" | null;
  score: number;
  reasons: string[];
  /** apa yang biasanya terjadi saat actual di atas/di bawah forecast */
  scenario: string | null;
}

interface Measure {
  re: RegExp;
  name: string;
  /** arah emas bila angkanya NAIK: −1 = SELL (data kuat/inflasi naik), +1 = BUY */
  up: 1 | -1;
  why: string;
  whyDown: string;
}

const MEASURES: Measure[] = [
  { re: /^federal funds rate/i, name: "Suku bunga Fed", up: -1, why: "suku bunga naik → imbal hasil & USD naik", whyDown: "suku bunga turun → imbal hasil & USD turun" },
  { re: /^core cpi/i, name: "Core CPI", up: -1, why: "inflasi inti naik → Fed cenderung ketat", whyDown: "inflasi inti melandai → ruang pemangkasan suku bunga" },
  { re: /^cpi/i, name: "CPI", up: -1, why: "inflasi naik → Fed cenderung ketat", whyDown: "inflasi melandai → ruang pemangkasan suku bunga" },
  { re: /^core ppi/i, name: "Core PPI", up: -1, why: "inflasi produsen naik → tekanan harga & Fed ketat", whyDown: "inflasi produsen melandai → tekanan harga mereda" },
  { re: /^ppi/i, name: "PPI", up: -1, why: "inflasi produsen naik → tekanan harga & Fed ketat", whyDown: "inflasi produsen melandai → tekanan harga mereda" },
  { re: /^non-farm employment change/i, name: "NFP", up: -1, why: "tenaga kerja kuat → USD & imbal hasil naik", whyDown: "tenaga kerja melemah → peluang suku bunga turun" },
  { re: /^average hourly earnings/i, name: "Upah per jam", up: -1, why: "upah naik → tekanan inflasi", whyDown: "upah melambat → tekanan inflasi mereda" },
  { re: /^unemployment rate/i, name: "Pengangguran", up: 1, why: "pengangguran naik → ekonomi melemah → peluang suku bunga turun", whyDown: "pengangguran turun → ekonomi kuat → Fed tetap ketat" },
];

/** "0.3%", "65K", "-12.5K", "1.2M", "4.00%" → angka (K/M/B dikalikan). */
export function parseEconValue(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.trim().replace(/,/g, "").replace(/[−–]/g, "-").match(/^(-?\d+(?:\.\d+)?)\s*([%KMB])?$/i);
  if (!m) return null;
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] ?? "").toUpperCase() as "K" | "M" | "B"] ?? 1;
  return Number(m[1]) * mult;
}

const side = (dir: number): EventBiasSide => (dir > 0 ? "BUY" : dir < 0 ? "SELL" : "NETRAL");

/** Selisih forecast−previous yang dianggap "sama": 0,05 poin untuk persen, 10% dari previous (min. 10K) untuk jumlah. */
function equalTol(raw: string, prev: number): number {
  return raw.trim().endsWith("%") ? 0.05 : Math.max(10_000, Math.abs(prev) * 0.1);
}

const NEWS_W: Record<NewsLike["confidence"], number> = { rendah: 1, sedang: 2, tinggi: 3 };

/**
 * Perkiraan arah untuk satu paket rilis (event berwaktu sama, mis. NFP + pengangguran + upah).
 * `news` = berita tersimpan (semua topik; disaring ke topik paket & 72 jam sebelum rilis).
 */
export function eventBias(events: EventLike[], news: NewsLike[] = [], nowMs = Date.now()): EventBias {
  const reasons: string[] = [];
  let exp = 0;
  let scenario: string | null = null;
  let scenarioRank = Infinity;
  for (const e of events) {
    const rank = MEASURES.findIndex((x) => x.re.test(e.title.trim()));
    if (rank < 0) continue;
    const m = MEASURES[rank];
    const f = parseEconValue(e.forecast);
    const p = parseEconValue(e.previous);
    // skenario dari angka utama paket (suku bunga > CPI > PPI > NFP > upah > pengangguran)
    if (e.forecast && rank < scenarioRank) {
      scenarioRank = rank;
      scenario = m.name === "Suku bunga Fed"
        ? `Saat rilis: suku bunga naik → cenderung SELL; turun → cenderung BUY; tetap ${e.forecast} → arah ditentukan nada pernyataan & konferensi pers (hawkish SELL, dovish BUY).`
        : `Saat rilis: ${m.name} actual di atas forecast ${e.forecast} → cenderung ${side(m.up)}; di bawah forecast → cenderung ${side(-m.up)}.`;
    }
    if (f == null || p == null) continue;
    const d = f - p;
    if (Math.abs(d) <= equalTol(e.forecast!, p)) {
      reasons.push(`${m.name}: forecast ${e.forecast} ≈ previous ${e.previous} → tanpa arah dari ekspektasi.`);
      continue;
    }
    const dir = d > 0 ? m.up : -m.up;
    exp += dir;
    reasons.push(`${m.name}: forecast ${e.forecast} ${d > 0 ? ">" : "<"} previous ${e.previous} → ${d > 0 ? m.why : m.whyDown} → cenderung ${side(dir)}.`);
  }
  const expScore = Math.sign(exp) * Math.min(2, Math.abs(exp) * 2);

  // nada berita topik yang sama 72 jam sebelum rilis
  const t = Math.min(...events.map((e) => Date.parse(e.time_at)));
  const topics = new Set(events.map((e) => calendarTopic(e.title)).filter((x): x is KeyTopic => !!x));
  let net = 0;
  let buy = 0;
  let sell = 0;
  for (const n of news) {
    if (!n.topic || !topics.has(n.topic as KeyTopic) || n.label === "neutral") continue;
    const at = Date.parse(n.published_at ?? n.created_at);
    if (!(at <= Math.min(t, nowMs) && at >= t - 72 * 3600_000)) continue;
    const w = NEWS_W[n.confidence] ?? 1;
    if (n.label === "bullish") {
      buy++;
      net += w;
    } else {
      sell++;
      net -= w;
    }
  }
  const newsScore = Math.abs(net) >= 6 ? 2 * Math.sign(net) : Math.abs(net) >= 3 ? Math.sign(net) : 0;
  if (buy + sell) reasons.push(`Berita ${[...topics].join("/")} 72 jam: ${sell} SELL vs ${buy} BUY (skor ${net > 0 ? "+" : ""}${net}) → ${newsScore ? `condong ${side(newsScore)}` : "belum tegas"}.`);
  else reasons.push(`Belum ada berita ${[...topics].join("/")} berarah dalam 72 jam terakhir.`);

  const score = expScore + newsScore;
  const agree = expScore !== 0 && newsScore !== 0 && Math.sign(expScore) === Math.sign(newsScore);
  return {
    side: side(score),
    strength: score === 0 ? null : agree && Math.abs(score) >= 3 ? "sedang" : "lemah",
    score,
    reasons,
    scenario,
  };
}

/** Kelompokkan event berwaktu & topik sama menjadi paket rilis. */
export function releaseGroups<T extends EventLike>(events: T[]): T[][] {
  const m = new Map<string, T[]>();
  for (const e of events) {
    const k = `${e.time_at}|${calendarTopic(e.title) ?? e.title}`;
    m.set(k, [...(m.get(k) ?? []), e]);
  }
  return [...m.values()];
}
