/**
 * News & kalender ekonomi — parser RSS/ForexFactory dan klasifikasi dampak
 * berita terhadap emas (XAUUSD) berbasis aturan yang transparan.
 *
 * Tanpa LLM berbayar: label berasal dari leksikon pendorong harga emas
 * (suku bunga Fed, USD, imbal hasil, inflasi, data AS, risiko geopolitik).
 * Hasilnya OPINI OTOMATIS, bukan sinyal atau probabilitas (docs/STRATEGY.md §12).
 */

export type GoldImpact = "bullish" | "bearish" | "neutral";

export interface NewsItem {
  title: string;
  link: string;
  source: string;
  publishedAt: number | null; // detik unix
  snippet: string;
}

export interface EconEvent {
  key: string;
  title: string;
  country: string;
  impact: "High" | "Medium" | "Low" | "Holiday";
  timeSec: number;
  forecast: string | null;
  previous: string | null;
}

export interface ImpactResult {
  label: GoldImpact;
  score: number;
  ruleIds: string[];
  reasons: string[];
  confidence: "rendah" | "sedang";
  conflict: boolean;
}

// ---------------------------------------------------------------------------
// RSS
// ---------------------------------------------------------------------------
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const stripCdata = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
/** Teks polos dari isi tag: CDATA → entitas → buang HTML → entitas lagi (konten ber-escape ganda). */
export function plainText(raw: string): string {
  return collapse(decodeEntities(decodeEntities(stripCdata(raw)).replace(/<[^>]*>/g, " ")));
}

function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : null;
}

/** Tanggal RSS: RFC 822 ("Sat, 17 Oct 2026 11:13:21 GMT") atau "YYYY-MM-DD HH:MM:SS" (dianggap UTC). */
export function parseRssDate(s: string | null): number | null {
  if (!s) return null;
  const t = s.trim();
  const bare = t.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/);
  const ms = Date.parse(bare ? `${bare[1]}T${bare[2]}Z` : t);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

const SNIPPET_MAX = 280;

export function parseRss(xml: string, fallbackSource: string): NewsItem[] {
  const out: NewsItem[] = [];
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const block = m[1];
    let title = plainText(tag(block, "title") ?? "");
    const link = plainText(tag(block, "link") ?? "");
    if (!title || !/^https?:\/\//i.test(link)) continue; // hanya tautan http(s)
    const source = plainText(tag(block, "source") ?? tag(block, "author") ?? "") || fallbackSource;
    // Google News menambahkan " - Nama Sumber" di akhir judul
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3)).trim();
    let snippet = plainText(tag(block, "description") ?? "");
    const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (norm(snippet).startsWith(norm(title))) snippet = ""; // deskripsi hanya mengulang judul
    if (snippet.length > SNIPPET_MAX) snippet = snippet.slice(0, SNIPPET_MAX - 1).trimEnd() + "…";
    out.push({ title: title.slice(0, 300), link: link.slice(0, 1000), source: source.slice(0, 80), publishedAt: parseRssDate(tag(block, "pubDate")), snippet });
  }
  return out;
}

/** Kunci dedupe lintas sumber: judul yang dinormalisasi (salinan sindikasi digabung). */
export function newsKey(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 160);
}

/** Buang duplikat (judul sama), simpan versi terbit paling awal; urut terbaru dulu. */
export function dedupeNews(items: NewsItem[]): NewsItem[] {
  const best = new Map<string, NewsItem>();
  for (const it of items) {
    const k = newsKey(it.title);
    if (!k) continue;
    const prev = best.get(k);
    if (!prev || (it.publishedAt ?? Infinity) < (prev.publishedAt ?? Infinity)) best.set(k, it);
  }
  return [...best.values()].sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
}

const RELEVANT = /\b(gold|xau|xauusd|bullion|precious metals?|fed|fomc|federal reserve|powell|treasur(?:y|ies)|yields?|dollar|usd|greenback|cpi|pce|inflation|payrolls?|nfp|jobs report|unemployment|rate (?:cut|hike)s?|safe[- ]haven)\b/i;

/** Gerbang relevansi kata kunci untuk berita yang memengaruhi emas. */
export function isGoldRelevant(title: string, snippet = ""): boolean {
  return RELEVANT.test(`${title} ${snippet}`);
}

// ---------------------------------------------------------------------------
// Klasifikasi dampak ke emas
// ---------------------------------------------------------------------------
interface Rule {
  id: string;
  dir: 1 | -1; // +1 mendukung emas (bullish), −1 menekan emas (bearish)
  weight: number;
  re: RegExp;
  reason: string;
}

const UP = "rises?|rose|jumps?|gains?|climbs?|rall(?:y|ies)|surges?|soars?|advances?|rebounds?|higher|firms?|strengthens?|spikes?";
const DOWN = "falls?|fell|drops?|slips?|slides?|declines?|retreats?|tumbles?|plunges?|sinks?|lower|loses?|eases?|weakens?|slumps?";

export const NEWS_RULES: Rule[] = [
  { id: "fed_dovish", dir: 1, weight: 2, re: /\brates? cuts?\b|\bcut(?:s|ting)? (?:interest )?rates?\b|\bdovish\b|\bmonetary easing\b/, reason: "Arah pemangkasan suku bunga (dovish) → imbal hasil turun → mendukung emas" },
  { id: "fed_hawkish", dir: -1, weight: 2, re: /\brates? hikes?\b|\bhike(?:s|d)? (?:interest )?rates?\b|\bhawkish\b|\bhigher for longer\b|\b(?:monetary|policy) tightening\b/, reason: "Arah suku bunga tinggi (hawkish) → menekan emas" },
  { id: "usd_weak", dir: 1, weight: 2, re: new RegExp(`\\b(?:dollar|usd|greenback)\\b[^.]{0,20}?\\b(?:${DOWN})\\b|\\bweak(?:er)? (?:us )?dollar\\b`), reason: "USD melemah → emas lebih murah bagi pembeli non-USD" },
  { id: "usd_strong", dir: -1, weight: 2, re: new RegExp(`\\b(?:dollar|usd|greenback)\\b[^.]{0,20}?\\b(?:${UP})\\b|\\bstrong(?:er)? (?:us )?dollar\\b`), reason: "USD menguat → menekan emas" },
  { id: "yields_down", dir: 1, weight: 2, re: new RegExp(`\\b(?:yields?|treasur(?:y|ies))\\b[^.]{0,20}?\\b(?:${DOWN})\\b|\\bbond rally\\b`), reason: "Imbal hasil obligasi turun → biaya peluang memegang emas turun" },
  { id: "yields_up", dir: -1, weight: 2, re: new RegExp(`\\b(?:yields?|treasur(?:y|ies))\\b[^.]{0,20}?\\b(?:${UP})\\b|\\bbond (?:sell-?off|rout)\\b`), reason: "Imbal hasil obligasi naik → menekan emas" },
  { id: "inflation_hot", dir: -1, weight: 2, re: /\b(?:hot|hotter|sticky|accelerating|higher[- ]than[- ]expected)\b[^.]{0,15}?\b(?:inflation|cpi|pce|consumer prices)\b|\b(?:inflation|cpi|pce)\b[^.]{0,20}?\b(?:heats? up|accelerates?|jumps?|beats?|tops? (?:forecasts?|expectations)|above (?:forecasts?|expectations))\b/, reason: "Inflasi AS di atas perkiraan → peluang suku bunga tinggi lebih lama → menekan emas" },
  { id: "inflation_cool", dir: 1, weight: 2, re: /\b(?:cool(?:er|ing)?|soft(?:er)?|slower|lower[- ]than[- ]expected)\b[^.]{0,15}?\b(?:inflation|cpi|pce|consumer prices)\b|\b(?:inflation|cpi|pce)\b[^.]{0,20}?\b(?:cools?|eases?|slows?|softens?|misses?|below (?:forecasts?|expectations))\b/, reason: "Inflasi AS melandai → ruang pemangkasan suku bunga → mendukung emas" },
  { id: "us_data_weak", dir: 1, weight: 2, re: /\b(?:weak(?:er)?|soft(?:er)?|disappointing|dismal)\b[^.]{0,15}?\b(?:jobs?|payrolls?|employment|gdp|retail sales|(?:us |u\.s\. |economic )?data)\b|\b(?:jobs?|payrolls?|nfp|employment|gdp|retail sales|pmi|jobless)\b[^.]{0,30}?\b(?:miss(?:es|ed)?|weak(?:er)?|disappoint\w*|slow(?:s|ed|ing|down)?|contract\w*|below (?:forecasts?|expectations))\b|\bunemployment\b[^.]{0,20}?\b(?:rises?|rose|jumps?|climbs?|higher)\b|\bjobless claims\b[^.]{0,20}?\b(?:rise|rises|rose|jump|jumps|climb)\b/, reason: "Data ekonomi AS lemah → peluang pemangkasan suku bunga → mendukung emas" },
  { id: "us_data_strong", dir: -1, weight: 2, re: /\b(?:strong(?:er)?|robust|blowout|solid)\b[^.]{0,15}?\b(?:jobs?|payrolls?|employment|gdp|retail sales|(?:us |u\.s\. |economic )?data)\b|\b(?:jobs?|payrolls?|nfp|employment|gdp|retail sales|pmi)\b[^.]{0,30}?\b(?:beats?|strong(?:er)?|robust|surges?|jumps?|tops? (?:forecasts?|expectations)|above (?:forecasts?|expectations))\b|\bunemployment\b[^.]{0,20}?\b(?:falls?|fell|drops?|lower)\b/, reason: "Data ekonomi AS kuat → USD & imbal hasil cenderung naik → menekan emas" },
  { id: "safe_haven", dir: 1, weight: 2, re: /\bsafe[- ]haven\b|\bgeopolitic\w*|\b(?:war|missile|airstrikes?|invasion|sanctions?)\b|\b(?:tensions?|crisis|turmoil|recession fears?|stock (?:market )?sell-?off|market rout)\b/, reason: "Risiko geopolitik/ketidakpastian → permintaan aset aman (safe haven)" },
  { id: "risk_on", dir: -1, weight: 2, re: /\b(?:ceasefire|truce|peace (?:deal|talks|agreement)|de-?escalat\w*|trade deal)\b/, reason: "Ketegangan mereda → permintaan safe haven berkurang" },
  { id: "demand_up", dir: 1, weight: 2, re: /\bcentral banks?\b[^.]{0,30}?\b(?:buy\w*|purchases?|add(?:s|ed|ing)?)\b|\b(?:etf|fund) inflows?\b/, reason: "Pembelian bank sentral / arus masuk ETF → permintaan emas" },
  { id: "price_up", dir: 1, weight: 1, re: new RegExp(`\\b(?:gold|xau(?:usd)?|bullion)\\b(?: prices?| futures)?[^.]{0,15}?\\b(?:${UP}|hits? (?:a )?record|record high|all-time high)\\b`), reason: "Laporan harga: emas menguat" },
  { id: "price_down", dir: -1, weight: 1, re: new RegExp(`\\b(?:gold|xau(?:usd)?|bullion)\\b(?: prices?| futures)?[^.]{0,15}?\\b(?:${DOWN}|selloff|sell-off)\\b`), reason: "Laporan harga: emas melemah" },
];

const NEGATION = /\b(?:no|not|never|without|unlikely(?: to)?|rules? out|ruled out|rejects?|delays?|delayed|pushes? back|scraps?|scrapped|fades?|fading)\b[^.]{0,12}$/;

/**
 * Klasifikasi berbasis aturan. Tiap aturan dihitung sekali; frasa yang didahului
 * negasi ("rules out rate cuts", "delays rate cut") membalik arah aturan tersebut.
 * Skor = Σ arah×bobot. Label hanya bila skor ≠ 0; pendorong bertentangan ditandai.
 */
export function classifyGoldImpact(title: string, snippet = ""): ImpactResult {
  const text = ` ${title}. ${snippet} `.toLowerCase().replace(/[’‘]/g, "'");
  let score = 0;
  let pos = 0;
  let neg = 0;
  const ruleIds: string[] = [];
  const reasons: string[] = [];
  for (const r of NEWS_RULES) {
    const m = r.re.exec(text);
    if (!m) continue;
    const before = text.slice(Math.max(0, m.index - 30), m.index);
    const negated = NEGATION.test(before);
    const dir = negated ? -r.dir : r.dir;
    score += dir * r.weight;
    if (dir > 0) pos += r.weight;
    else neg += r.weight;
    ruleIds.push(negated ? `${r.id}:neg` : r.id);
    reasons.push(negated ? `Kebalikan dari: ${r.reason.toLowerCase()}` : r.reason);
  }
  const label: GoldImpact = score > 0 ? "bullish" : score < 0 ? "bearish" : "neutral";
  const conflict = pos > 0 && neg > 0;
  const drivers = ruleIds.filter((id) => !id.startsWith("price_")).length;
  const confidence = label !== "neutral" && !conflict && drivers >= 2 ? "sedang" : "rendah";
  return { label, score, ruleIds, reasons, confidence, conflict };
}

/** Kalimat penjelasan berbahasa Indonesia untuk kartu berita. */
export function explainImpact(r: Pick<ImpactResult, "label" | "reasons" | "conflict">): string {
  if (!r.reasons.length) return "Netral: tidak terdeteksi pendorong utama harga emas pada judul berita ini.";
  const head = r.label === "bullish" ? "Cenderung POSITIF untuk emas" : r.label === "bearish" ? "Cenderung NEGATIF untuk emas" : "Netral — pendorong saling meniadakan";
  return `${head}${r.conflict && r.label !== "neutral" ? " (ada faktor yang bertentangan)" : ""}: ${r.reasons.join("; ")}.`;
}

// ---------------------------------------------------------------------------
// Embedding (model gte-small bawaan Supabase) — opsional, dipakai engine
// ---------------------------------------------------------------------------
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Kemiripan tertinggi terhadap kalimat prototipe (relevansi pasar emas). */
export function maxSimilarity(vec: ArrayLike<number>, protos: ArrayLike<number>[]): number {
  return protos.reduce((m, p) => Math.max(m, cosine(vec, p)), 0);
}

// ---------------------------------------------------------------------------
// Kalender ekonomi (feed mingguan ForexFactory/faireconomy)
// ---------------------------------------------------------------------------
const IMPACTS = new Set(["High", "Medium", "Low", "Holiday"]);

/**
 * Feed ini TIDAK memuat angka "actual" — hanya forecast & previous.
 * Hanya mata uang di `countries` (default USD) dan dampak di `impacts`.
 */
export function parseFfCalendar(json: unknown, countries = ["USD"], impacts = ["High", "Medium"]): EconEvent[] {
  if (!Array.isArray(json)) return [];
  const out: EconEvent[] = [];
  for (const e of json as Record<string, unknown>[]) {
    const title = typeof e?.title === "string" ? collapse(e.title) : "";
    const country = typeof e?.country === "string" ? e.country : "";
    const impact = typeof e?.impact === "string" ? e.impact : "";
    const ms = typeof e?.date === "string" ? Date.parse(e.date) : NaN;
    if (!title || !countries.includes(country) || !IMPACTS.has(impact) || !impacts.includes(impact) || !Number.isFinite(ms)) continue;
    const val = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 20) : null);
    const timeSec = Math.floor(ms / 1000);
    out.push({ key: `${country}|${title}|${timeSec}`.slice(0, 200), title: title.slice(0, 120), country, impact: impact as EconEvent["impact"], timeSec, forecast: val(e.forecast), previous: val(e.previous) });
  }
  return out.sort((a, b) => a.timeSec - b.timeSec);
}

/** Event berdampak tinggi yang dimulai dalam `minutes` menit ke depan (belum lewat). */
export function eventsInAlertWindow<T extends { impact: string; timeSec: number }>(events: T[], nowSec: number, minutes: number): T[] {
  return events.filter((e) => e.impact === "High" && e.timeSec > nowSec && e.timeSec - nowSec <= minutes * 60);
}

export function newsEventTitle(e: { title: string; country: string; timeSec: number }, nowSec: number): string {
  const mins = Math.max(1, Math.round((e.timeSec - nowSec) / 60));
  return `⚠️ NEWS BESAR ${mins} menit lagi: ${e.title} (${e.country})`;
}

export function newsEventBody(e: { forecast: string | null; previous: string | null }): string {
  const nums = [e.forecast ? `forecast ${e.forecast}` : null, e.previous ? `previous ${e.previous}` : null].filter(Boolean).join(", ");
  return `${nums ? nums + ". " : ""}Volatilitas XAUUSD bisa tinggi & spread melebar. Pertimbangkan menunda entry atau memperketat manajemen risiko.`;
}
