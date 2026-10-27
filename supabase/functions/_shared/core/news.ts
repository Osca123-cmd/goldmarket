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

/** Arah untuk XAUUSD: bullish emas = BUY, bearish emas = SELL. */
export type NewsBias = "BUY" | "SELL" | "NETRAL";
export type BiasStrength = "lemah" | "sedang" | "kuat";

export interface ImpactResult {
  label: GoldImpact;
  bias: NewsBias;
  /** null bila netral */
  strength: BiasStrength | null;
  score: number;
  ruleIds: string[];
  /** alasan per pendorong, dengan kutipan frasa pemicu dari judul */
  reasons: string[];
  /** kolom DB: kuat → tinggi, sedang → sedang, lemah/netral → rendah */
  confidence: "rendah" | "sedang" | "tinggi";
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

/** Rilis Federal Reserve yang relevan untuk pasar (bukan izin bank / enforcement). */
export const FED_POLICY = /\b(?:fomc|federal open market committee|monetary policy|discount rate|interest on reserve|economic projections|minutes|beige book|statement)\b/i;

/** Gerbang relevansi kata kunci untuk berita yang memengaruhi emas. */
export function isGoldRelevant(title: string, snippet = ""): boolean {
  return RELEVANT.test(`${title} ${snippet}`);
}

// ---------------------------------------------------------------------------
// Klasifikasi dampak ke emas
// ---------------------------------------------------------------------------
type Driver = "fed" | "usd" | "yields" | "inflation" | "data" | "geo" | "demand" | "price";

interface Rule {
  id: string;
  /** pendorong yang sama dihitung sekali (mis. "dollar holds firm" + "pound slips" = satu faktor USD) */
  group: Driver;
  dir: 1 | -1; // +1 mendukung emas (BUY), −1 menekan emas (SELL)
  weight: number;
  re: RegExp;
  reason: string;
  /** hanya berlaku untuk data AS: dilewati bila berita jelas tentang negara lain */
  usOnly?: boolean;
  /** lebih ketat: butuh penanda AS (atau CPI/PPI/PCE tanpa nama negara lain) */
  needUs?: boolean;
  /** frasa yang cocok "dimakan" agar aturan berikutnya tidak membacanya lagi (mis. "tensions ease" bukan risiko) */
  consume?: boolean;
}

// Negara/penanda non-AS (judul berita data negara lain tidak boleh memicu aturan data AS / topik CPI·PPI)
const FOREIGN =
  /(?:\bu\.k\.(?!\w)|\b(?:australia|australian|aussie|canada|canadian|uk|britain|british|england|euro ?zone|ecb|germany|german|france|french|italy|italian|spain|spain's|spanish|netherlands|dutch|ireland|irish|sweden|swedish|norway|norwegian|denmark|danish|switzerland|swiss|poland|polish|czech|hungary|romania|ukraine|russia|turkey|turkish|greece|portugal|austria|belgium|finland|slovenia|slovakia|croatia|serbia|bosnia|montenegro|japan|japanese|boj|china|chinese|korea|korean|kospi|chuseok|hanwoo|india|indian|nifty|sensex|indonesia|malaysia|thailand|vietnam|philippines|singapore|taiwan|hong kong|new zealand|brazil|mexico|argentina|chile|colombia|peru|paraguay|uruguay|south africa|nigeria|egypt|israel|saudi|uae|qatar|pakistan|bangladesh|sri lanka|rba|boc|boe)\b)/;
const US = /(?:\bu\.s\.(?!\w)|\b(?:us|usa|united states|american|america|fed|fomc|federal reserve|treasur(?:y|ies)|powell|warsh|wall st(?:reet)?)\b)/;

// "dollar" milik negara lain (Canadian dollar, Aussie dollar, …) bukan USD
const NOT_USD = "(?<!(?:canadian|australian|aussie|kiwi|new zealand|singapore|hong kong|taiwan|taiwanese|zimbabwe) )";
// "(?<!/)": "usd" di EUR/USD, AUD/USD bukan pernyataan tentang USD sendiri
const USD = `${NOT_USD}(?<!/)\\b(?:us\\s|u\\.s\\.\\s)?(?:dollar index|dollar|usd|greenback|dxy)\\b`;
const UP = "rises?|rose|jumps?|gains?|climbs?|rall(?:y|ies)|surges?|soars?|advances?|rebounds?|higher|firms?|strengthens?|spikes?";
const DOWN = "falls?|fell|drops?|slips?|slides?|declines?|retreats?|tumbles?|plunges?|sinks?|lower|loses?|eases?|weakens?|slumps?";
// mata uang yang naik = USD melemah (EUR/USD, GBP/USD, yen, ringgit, …)
const FX = "eur/usd|gbp/usd|aud/usd|nzd/usd|euro(?![ -]?zone)|pound|sterling|cable|aussie|australian dollar|kiwi|new zealand dollar|yen|swiss franc|yuan|renminbi|ringgit|rupee|rupiah|peso|rand|lira|asian currencies|emerging(?:-market)? currencies|singapore dollar|canadian dollar|loonie";
// pasangan dengan USD di depan: naik = USD menguat
const USD_BASE = "usd/jpy|usd/cad|usd/chf|usd/cnh|usdjpy|dollar[- /]yen";
const NOT_HALTED = "(?<!halts? (?:a |its |the )?(?:[\\w-]+ )?)";
const LOWS = "(?:near|at|to|hits?|touch\\w*|around) (?:(?:\\d+|multi|two|three|four|six)[- ](?:week|month|year|mth) )?lows?";
const HIGHS = "(?:near|at|to|hits?|touch\\w*|around) (?:(?:\\d+|multi|two|three|four|six)[- ](?:week|month|year|mth) )?highs?";
const INFL = "inflation|cpi|pce|ppi|consumer prices|producer prices|wholesale prices";
const GOLD = "\\b(?:gold|xau(?:usd)?|bullion|yellow metal)\\b(?: prices?| futures)?";

export const NEWS_RULES: Rule[] = [
  // ---- The Fed ----
  { id: "fed_hawkish", group: "fed", dir: -1, weight: 2, re: /\brate[- ]hikes?\b|\bhike(?:s|d)? (?:interest )?rates?\b|\bhikes? another\b|\b(?:rais(?:e|es|ed|ing)|increas(?:e|es|ed|ing)) (?:interest )?rates\b|\brate increases?\b|\b(?:another|more|further|additional|december|november|next) (?:\d+ ?(?:bp|basis[- ]points?) )?(?:rate )?hikes?\b|\bhike (?:odds|bets|risk|looms)\b|\bhawkish\b|\bhigher for longer\b|\b(?:monetary|policy|further) tightening\b|\btightening cycle\b/, reason: "Arah suku bunga Fed naik/tinggi lebih lama (hawkish) → imbal hasil & USD naik → menekan emas" },
  { id: "fed_dovish", group: "fed", dir: 1, weight: 2, re: /\brates? cuts?\b|\bcut(?:s|ting)? (?:interest )?rates?\b|\bdovish\b|\bmonetary easing\b|\beasing cycle\b|\bpivot\b/, reason: "Arah pemangkasan suku bunga Fed (dovish) → imbal hasil turun → mendukung emas" },
  // ---- USD (pernyataan langsung lebih dulu, lalu disimpulkan dari pasangan mata uang) ----
  { id: "usd_strong", group: "usd", dir: -1, weight: 2, re: new RegExp(`${USD}[^.]{0,30}?\\b(?:${UP}|firm(?:s|er)?|holds? (?:firm|ground)|stays? (?:firm|bid)|keeps? firm|firm tone|bid|resilient|bullish|positive bias|strength)\\b|\\bstrong(?:er)? ${USD}|${USD}[- ](?:bullish|bulls?|buying|demand)\\b|\\bbullish (?:us )?(?:dollar|usd|dxy)\\b`), reason: "USD menguat → emas lebih mahal bagi pembeli non-USD → menekan emas" },
  { id: "usd_weak", group: "usd", dir: 1, weight: 2, re: new RegExp(`${USD}[^.]{0,25}?${NOT_HALTED}\\b(?:${DOWN}|wobbles?|under pressure|on the back foot|snaps? (?:a )?(?:\\w+-week |\\w+-day )?(?:win(?:ning)? )?streak)\\b|\\bweak(?:er|ening)? ${USD}|${USD}[- ](?:selling|bears?|weakness)\\b`), reason: "USD melemah → emas lebih murah bagi pembeli non-USD → mendukung emas" },
  { id: "fx_usd_strong", group: "usd", usOnly: true, dir: -1, weight: 2, re: new RegExp(`\\b(?:${FX})\\b[^.]{0,20}?${NOT_HALTED}\\b(?:${DOWN}|easier|under pressure|depressed|pressured|at the lows|weak(?:er|ness)?)\\b|\\b(?:${USD_BASE})\\b[^.]{0,20}?\\b(?:${UP})\\b|\\b(?:yen|euro|pound) selling\\b`), reason: "Mata uang lain melemah terhadap USD (USD menguat) → menekan emas" },
  { id: "fx_usd_weak", group: "usd", usOnly: true, dir: 1, weight: 2, re: new RegExp(`\\b(?:${FX})\\b[^.]{0,20}?\\b(?:${UP}|recovers?|gathers? strength)\\b|\\b(?:${USD_BASE})\\b[^.]{0,20}?\\b(?:${DOWN})\\b|\\byen[- ]buying\\b`), reason: "Mata uang lain menguat terhadap USD (USD melemah) → mendukung emas" },
  // ---- imbal hasil obligasi AS ----
  { id: "yields_down", group: "yields", usOnly: true, dir: 1, weight: 2, re: new RegExp(`\\b(?:yields?|treasur(?:y|ies))\\b[^.]{0,20}?\\b(?:${DOWN})\\b|\\b(?:yields?|treasur(?:y|ies))\\b[^.]{0,30}?\\b${LOWS}\\b|\\bbond rally\\b`), reason: "Imbal hasil obligasi AS turun → biaya peluang memegang emas turun → mendukung emas" },
  { id: "yields_up", group: "yields", usOnly: true, dir: -1, weight: 2, re: new RegExp(`\\b(?:yields?|treasur(?:y|ies))\\b[^.]{0,20}?\\b(?:${UP})\\b|\\b(?:yields?|treasur(?:y|ies))\\b[^.]{0,30}?\\b${HIGHS}\\b|\\byields? (?:return|climb|back) (?:to|above) \\d|\\bbond (?:sell-?off|rout)\\b`), reason: "Imbal hasil obligasi AS naik → menekan emas" },
  // ---- inflasi AS ----
  { id: "inflation_hot", group: "inflation", usOnly: true, dir: -1, weight: 2, re: new RegExp(`\\b(?:hot|hotter|red[- ]hot|sticky|firmer|accelerating|higher[- ]than[- ]expected)\\b[^.]{0,15}?\\b(?:${INFL})\\b|\\b(?:${INFL})\\b[^.]{0,30}?\\b(?:(?:hott?er|higher|firmer) than expected|heats? up|accelerates?|beats?|tops? (?:forecasts?|expectations)|above (?:forecasts?|expectations)|(?:comes?|came|coming) in (?:red )?hot|red[- ]hot|hits? (?:a )?(?:\\d+|multi)-(?:month|year) high|highest (?:since|in)|fastest since|biggest (?:annual |monthly )?(?:gain|jump|rise|increase) since)\\b|\\b(?:revives?|stokes?|fuels?) inflation (?:fears?|worries|concerns)\\b|\\binflation (?:fears?|worries|concerns) (?:rise|rises|grow|grows|mount|mounts)\\b`), reason: "Inflasi AS panas → Fed cenderung menahan/menaikkan suku bunga → menekan emas" },
  { id: "inflation_up", group: "inflation", needUs: true, dir: -1, weight: 1, re: new RegExp(`\\b(?:${INFL})\\b[^.]{0,15}?\\b(?:rises?|rose|climbs?|climbed|jumps?|increases? to|up \\d)`), reason: "Inflasi AS naik → ruang pemangkasan suku bunga menyempit → cenderung menekan emas" },
  { id: "inflation_cool", group: "inflation", usOnly: true, dir: 1, weight: 2, re: new RegExp(`\\b(?:cool(?:er|ing)?|soft(?:er)?|slower|lower[- ]than[- ]expected)\\b[^.]{0,15}?\\b(?:${INFL})\\b|\\b(?:${INFL})\\b[^.]{0,20}?\\b(?:(?:cooler|softer|lower|less) than expected|cools?|eases?|slows?|softens?|misses?|below (?:forecasts?|expectations))\\b`), reason: "Inflasi AS melandai → ruang pemangkasan suku bunga → mendukung emas" },
  // ---- data ekonomi AS ----
  { id: "us_data_weak", group: "data", usOnly: true, dir: 1, weight: 2, re: /\b(?:weak(?:er)?|soft(?:er)?|disappointing|dismal)\b[^.]{0,15}?\b(?:jobs?|payrolls?|employment|gdp|retail sales|(?:us |u\.s\. |economic )?data)\b|\b(?:jobs?|payrolls?|nfp|employment|gdp|retail sales|pmi|jobless)\b[^.]{0,30}?\b(?:miss(?:es|ed)?|weak(?:er)?|disappoint\w*|slow(?:s|ed|ing|down)?|contract\w*|below (?:forecasts?|expectations))\b|\bunemployment\b[^.]{0,20}?\b(?:rises?|rose|jumps?|climbs?|higher)\b|\bjobless claims\b[^.]{0,20}?\b(?:rise|rises|rose|jump|jumps|climb)\b|\bconsumer confidence\b[^.]{0,10}?\b(?:slips?|falls?|fell|drops?|sinks?|plunges?|slumps?)\b|\bhousing\b[^.]{0,20}?\b(?:deteriorat\w*|warning signs?|slump\w*)\b/, reason: "Data ekonomi AS lemah → peluang pemangkasan suku bunga → mendukung emas" },
  { id: "us_data_strong", group: "data", usOnly: true, dir: -1, weight: 2, re: /\b(?:strong(?:er)?|robust|blowout|solid)\b[^.]{0,15}?\b(?:jobs?|payrolls?|employment|gdp|retail sales|(?:us |u\.s\. |economic )?data)\b|\b(?:jobs?|payrolls?|nfp|employment|gdp|retail sales|pmi)\b[^.]{0,30}?\b(?:beats?|strong(?:er)?|robust|surges?|jumps?|tops? (?:forecasts?|expectations)|above (?:forecasts?|expectations))\b|\bunemployment\b[^.]{0,20}?\b(?:falls?|fell|drops?|lower)\b/, reason: "Data ekonomi AS kuat → USD & imbal hasil cenderung naik → menekan emas" },
  // ---- geopolitik: de-eskalasi dibaca lebih dulu agar "tensions ease" tidak terbaca sebagai risiko ----
  { id: "risk_on", group: "geo", dir: -1, weight: 2, consume: true, re: /\b(?:ceasefire|truce|peace (?:deal|talks|agreement|hopes?|plan)|de-?escalat\w*|trade deal)\b|\b(?:diplomacy|diplomatic)\b[^.]{0,12}?\b(?:hopes?|progress|breakthrough)\b|\b(?:eas(?:e|es|ed|ing)|cool(?:s|ed|ing)?|subsid(?:e|es|ed|ing)|fad(?:e|es|ed|ing)|abat(?:e|es|ed|ing))\b[^.]{0,20}?\b(?:tensions?|fears?|risks?)\b|\b(?:tensions?|fears?)\b[^.]{0,10}?\b(?:eas(?:e|es|ed|ing)|subsid(?:e|es|ed|ing)|cool(?:s|ed|ing)?|fad(?:e|es|ed|ing)|abat(?:e|es|ed|ing))\b/, reason: "Ketegangan/risiko mereda → permintaan aset aman (safe haven) berkurang → menekan emas" },
  { id: "safe_haven", group: "geo", dir: 1, weight: 2, re: /\bsafe[- ]haven\b|\bgeopolitic\w*|\b(?:war|missiles?|airstrikes?|invasion|sanctions?|escalat\w*)\b|\b(?:west asia|w asia|middle east) (?:risks?|tensions?|conflict)\b|\b(?:tensions?|crisis|turmoil|recession fears?|risk aversion|stock (?:market )?sell-?off|market rout)\b/, reason: "Risiko geopolitik/ketidakpastian naik → permintaan aset aman (safe haven) → mendukung emas" },
  // ---- permintaan fisik ----
  { id: "demand_up", group: "demand", dir: 1, weight: 2, re: /\bcentral banks?\b[^.]{0,30}?\b(?:buy\w*|purchases?|add(?:s|ed|ing)?)\b|\b(?:etf|fund) inflows?\b/, reason: "Pembelian bank sentral / arus masuk ETF → permintaan emas naik → mendukung emas" },
  // ---- laporan harga emas (menggambarkan gerak yang sudah terjadi; bobot kecil) ----
  { id: "price_up", group: "price", dir: 1, weight: 1, re: new RegExp(`${GOLD}[^.]{0,15}?\\b(?:${UP}|recover(?:s|y|ed)?|reclaims?|retakes?|bounces?|hits? (?:a )?record|record high|all-time high)\\b|\\b(?:lifts?|boosts?|supports?) gold\\b`), reason: "Laporan harga: emas sedang menguat" },
  { id: "price_down", group: "price", dir: -1, weight: 1, re: new RegExp(`${GOLD}[^.]{0,15}?\\b(?:${DOWN}|down \\d+(?:\\.\\d+)?%(?! yoy| y\\/y| year)|selloff|sell-off|struggles?|sticks? to (?:intraday )?losses|under pressure)\\b|${GOLD}[^.]{0,50}?\\bupside (?:seems |looks )?limited\\b`), reason: "Laporan harga: emas sedang melemah" },
];

// sebelum frasa: membalik arah ("rules out rate cuts", "fewer rate hikes")
const NEGATION = /\b(?:no|not|never|without|unlikely(?: to)?|rules? out|ruled out|rejects?|delays?|delayed|pushes? back|scraps?|scrapped|fades?|fading|fewer|less|end (?:of|to))\b[^.]{0,12}$/;
// sesudah frasa: membalik arah ("rate cuts not until 2028")
const NEGATION_AFTER = /^[^.]{0,6}\b(?:not until|unlikely|off the table|ruled out)\b/;
// jeda/ragu: tidak dihitung ("skip October rate hike", "pause on rate hikes", "keeps USD bulls on hold")
const CANCEL = /\b(?:pause[sd]? (?:on|in)|hit pause on|skip(?:s|ping)?|or not to)\b[^.]{0,20}$/;
const CANCEL_AFTER = /^[^.]{0,4}\b(?:pause|on hold)\b/;

const AGAINST = "Berlawanan: ";
const STRENGTH_CONF: Record<BiasStrength, ImpactResult["confidence"]> = { lemah: "rendah", sedang: "sedang", kuat: "tinggi" };

/**
 * Klasifikasi berbasis aturan → bias BUY/SELL XAUUSD + kekuatan + alasan berkutipan.
 * - Pendorong dikelompokkan (Fed, USD, imbal hasil, inflasi, data AS, geopolitik, permintaan, harga);
 *   satu kelompok dihitung sekali dengan arah = jumlah aturan yang cocok di kelompok itu.
 * - Negasi sebelum/sesudah frasa membalik arah; "pause/skip" membatalkan frasa.
 * - Skor = Σ arah×bobot kelompok. Kuat: ≥2 pendorong searah tanpa lawan (skor ≥4); sedang: ≥1 pendorong
 *   tanpa lawan (skor ≥2); lemah: hanya laporan harga, ada pendorong berlawanan, atau judul berupa pertanyaan.
 * - Ini membaca ARAH FUNDAMENTAL judul, bukan waktu entry: uji 20–27 Okt 2026 (86 judul berarah) tidak
 *   menunjukkan daya prediksi gerak XAU 1–4 jam sesudah terbit (51%). Lihat docs/STRATEGY.md §12.
 */
export function classifyGoldImpact(title: string, snippet = ""): ImpactResult {
  const orig = ` ${title}. ${snippet} `.replace(/[’‘]/g, "'");
  let text = orig.toLowerCase();
  const sameLen = text.length === orig.length;
  const foreignOnly = FOREIGN.test(text) && !US.test(text);
  const usMarked = US.test(text) || (/\b(?:cpi|ppi|pce)\b/.test(text) && !FOREIGN.test(text));
  const hits: { r: Rule; dir: number; quote: string; negated: boolean }[] = [];
  for (const r of NEWS_RULES) {
    if (r.usOnly && foreignOnly) continue;
    if (r.needUs && !usMarked) continue;
    const m = r.re.exec(text);
    if (!m) continue;
    const before = text.slice(Math.max(0, m.index - 30), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 25);
    if (r.consume) text = text.slice(0, m.index) + " ".repeat(m[0].length) + text.slice(m.index + m[0].length);
    if (CANCEL.test(before) || CANCEL_AFTER.test(after)) continue;
    const negated = NEGATION.test(before) || NEGATION_AFTER.test(after);
    const quote = (sameLen ? orig : text).slice(m.index, m.index + m[0].length).trim().slice(0, 70);
    hits.push({ r, dir: negated ? -r.dir : r.dir, quote, negated });
  }

  // satu suara per kelompok pendorong
  const groups = new Map<Driver, { dir: number; weight: number; hits: typeof hits }>();
  for (const h of hits) {
    const g = groups.get(h.r.group) ?? { dir: 0, weight: 0, hits: [] };
    g.dir += h.dir;
    g.hits.push(h);
    groups.set(h.r.group, g);
  }
  let score = 0;
  let pos = 0;
  let neg = 0;
  const voted: { dir: 1 | -1; driver: boolean; hits: typeof hits }[] = [];
  for (const [group, g] of groups) {
    if (g.dir === 0) continue; // kelompok saling meniadakan
    const dir = g.dir > 0 ? 1 : -1;
    const win = g.hits.filter((h) => h.dir === dir);
    const weight = Math.max(...win.map((h) => h.r.weight));
    score += dir * weight;
    if (dir > 0) pos += weight;
    else neg += weight;
    voted.push({ dir, driver: group !== "price", hits: win });
  }

  const label: GoldImpact = score > 0 ? "bullish" : score < 0 ? "bearish" : "neutral";
  const sign = score > 0 ? 1 : -1;
  const conflict = pos > 0 && neg > 0;
  const drivers = voted.filter((v) => v.driver && v.dir === sign).length;
  // judul berupa pertanyaan/pengandaian ("Will the Fed…?", "What if CPI…") hanya bias lemah
  const speculative = /\?|^\s*(?:what if|will|can|could|should|is|are|does|do)\b/i.test(title);
  const strength: BiasStrength | null =
    label === "neutral" ? null : speculative || conflict || drivers === 0 || Math.abs(score) < 2 ? "lemah" : drivers >= 2 && Math.abs(score) >= 4 ? "kuat" : "sedang";
  // alasan: pendukung arah lebih dulu, lalu yang berlawanan
  const ordered = label === "neutral" ? voted : [...voted.filter((v) => v.dir === sign), ...voted.filter((v) => v.dir !== sign)];
  const ruleIds: string[] = [];
  const reasons: string[] = [];
  for (const v of ordered) {
    for (const h of v.hits) {
      ruleIds.push(h.negated ? `${h.r.id}:neg` : h.r.id);
      if (v.hits[0] !== h) continue; // satu alasan per kelompok
      reasons.push(`${label !== "neutral" && v.dir !== sign ? AGAINST : ""}${h.negated ? `Kebalikan dari: ${h.r.reason.charAt(0).toLowerCase()}${h.r.reason.slice(1)}` : h.r.reason} — “${h.quote}”`);
    }
  }
  return {
    label,
    bias: label === "bullish" ? "BUY" : label === "bearish" ? "SELL" : "NETRAL",
    strength,
    score,
    ruleIds,
    reasons,
    confidence: strength ? STRENGTH_CONF[strength] : "rendah",
    conflict,
  };
}

/** Kalimat penjelasan berbahasa Indonesia untuk kartu berita. */
export function explainImpact(r: Pick<ImpactResult, "label" | "reasons" | "conflict"> & Partial<Pick<ImpactResult, "strength" | "score">>): string {
  if (!r.reasons.length) return "Netral: tidak terdeteksi pendorong utama harga emas pada judul berita ini.";
  if (r.label === "neutral") return `Netral — pendorong saling meniadakan: ${r.reasons.join("; ")}.`;
  const head = `${r.label === "bullish" ? "BUY XAUUSD" : "SELL XAUUSD"}${r.strength ? ` (bias ${r.strength})` : ""}`;
  const support = r.reasons.filter((x) => !x.startsWith(AGAINST));
  const against = r.reasons.filter((x) => x.startsWith(AGAINST)).map((x) => x.slice(AGAINST.length));
  return `${head}: ${support.join("; ")}.${against.length ? ` Faktor berlawanan: ${against.join("; ")}.` : ""}`;
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
  const topic = calendarTopic(e.title);
  return `⚠️ ${topic ? `NEWS ${topic}` : "NEWS BESAR"} ${mins} menit lagi: ${e.title} (${e.country})`;
}

export function newsEventBody(e: { forecast: string | null; previous: string | null }): string {
  const nums = [e.forecast ? `forecast ${e.forecast}` : null, e.previous ? `previous ${e.previous}` : null].filter(Boolean).join(", ");
  return `${nums ? nums + ". " : ""}Volatilitas XAUUSD bisa tinggi & spread melebar. Pertimbangkan menunda entry atau memperketat manajemen risiko.`;
}

// ---------------------------------------------------------------------------
// Fokus topik: hanya FOMC, NFP, CPI, PPI (berita, kalender, notifikasi)
// ---------------------------------------------------------------------------
export type KeyTopic = "FOMC" | "NFP" | "CPI" | "PPI";
export const KEY_TOPICS: KeyTopic[] = ["FOMC", "NFP", "CPI", "PPI"];

const TOPIC_NEWS: [KeyTopic, RegExp][] = [
  ["FOMC", /\bfomc\b|\bfederal open market committee\b|\bfederal funds rate\b|\bdot plot\b|\b(?:fed|federal reserve)\b[^.]{0,40}?\b(?:rate decision|policy decision|decision|holds?|held|hold rates|keeps? rates|cuts?|cutting|raises?|hikes?|hiking|minutes|meeting|projections)\b/],
  ["NFP", /\bnfp\b|\bnon-?farm payrolls?\b|\bnonfarm\b|\bpayrolls?\b|\bjobs report\b|\bemployment report\b/],
  ["CPI", /\bcpi\b|\bconsumer price(?:s| index)\b|\binflation (?:data|report|figures|reading|print)\b/],
  ["PPI", /\bppi\b|\bproducer price(?:s| index)\b|\bwholesale (?:prices|inflation)\b/],
];

/**
 * Topik utama berita (urutan prioritas FOMC → NFP → CPI → PPI) atau null.
 * Berita yang jelas tentang negara lain (mis. CPI Inggris) tidak dihitung; ADP bukan NFP.
 */
export function newsTopic(title: string, snippet = ""): KeyTopic | null {
  const text = ` ${title}. ${snippet} `.toLowerCase();
  if (FOREIGN.test(text) && !US.test(text)) return null;
  // laporan ADP (swasta) bukan NFP: buang frasa ADP sebelum mencocokkan NFP
  const noAdp = text.replace(/\badp\b[^.]{0,30}?\b(?:non-?farm |private )?(?:employment|payrolls?|jobs(?: report)?)\b/g, " ");
  for (const [topic, re] of TOPIC_NEWS) {
    if (re.test(topic === "NFP" ? noAdp : text)) return topic;
  }
  return null;
}

/**
 * Event FOMC/NFP/CPI/PPI dalam ±`minutes` dari `nowSec` — jendela di mana engine
 * tidak membuat setup baru (volatilitas & spread melonjak saat rilis).
 */
export function newsBlackoutAt<T extends { title: string; timeSec: number }>(events: T[], nowSec: number, minutes: number): T | null {
  return events.find((e) => calendarTopic(e.title) !== null && Math.abs(e.timeSec - nowSec) <= minutes * 60) ?? null;
}

/**
 * Topik event kalender ForexFactory (judul persis dari feed). NFP mencakup paket
 * laporan tenaga kerja yang rilis bersamaan (Non-Farm, Unemployment Rate,
 * Average Hourly Earnings); "ADP Non-Farm" bukan NFP.
 */
export function calendarTopic(title: string): KeyTopic | null {
  const t = title.trim().toLowerCase();
  // FOMC = keputusan & dokumen rapat; pidato anggota ("FOMC Member X Speaks") tidak termasuk
  if (/^(?:federal funds rate|fomc (?:statement|press conference|meeting minutes|economic projections))/.test(t)) return "FOMC";
  if (/^(?:non-farm employment change|unemployment rate|average hourly earnings)/.test(t)) return "NFP";
  if (/^(?:core )?cpi\b/.test(t)) return "CPI";
  if (/^(?:core )?ppi\b/.test(t)) return "PPI";
  return null;
}
