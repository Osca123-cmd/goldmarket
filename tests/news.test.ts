import { describe, expect, it } from "vitest";
import {
  classifyGoldImpact,
  cosine,
  dedupeNews,
  eventsInAlertWindow,
  explainImpact,
  newsBlackoutAt,
  calendarTopic,
  newsTopic,
  FED_POLICY,
  isGoldRelevant,
  newsEventBody,
  newsEventTitle,
  parseFfCalendar,
  parseRss,
  parseRssDate,
  plainText,
} from "../src/core/news.ts";

// Struktur nyata (disederhanakan) dari Google News RSS dan Investing.com RSS
const GOOGLE = `<?xml version="1.0"?><rss><channel><title>x</title>
<item><title>Gold Price Slides on Hot Inflation, but Schiff Says It’s a Gift - Yahoo Finance</title><link>https://news.google.com/rss/articles/abc?oc=5</link><pubDate>Sat, 17 Oct 2026 11:13:21 GMT</pubDate><description>&lt;a href="https://news.google.com/rss/articles/abc" target="_blank"&gt;Gold Price Slides on Hot Inflation, but Schiff Says It’s a Gift&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;Yahoo Finance&lt;/font&gt;</description><source url="https://finance.yahoo.com">Yahoo Finance</source></item>
<item><title><![CDATA[Fed's Powell signals rate cuts &amp; patience]]></title><link>https://example.com/a</link><pubDate>Fri, 16 Oct 2026 20:00:00 GMT</pubDate><description><![CDATA[<p>Chair says <b>policy</b> is restrictive.</p>]]></description></item>
<item><title>Bad link</title><link>javascript:alert(1)</link></item>
<item><title></title><link>https://example.com/empty</link></item>
</channel></rss>`;

const INVESTING = `<rss version="2.0"><channel><title>Commodities &amp; Futures News</title>
<item><enclosure url="https://x/y.jpg" length="1" type="image/jpeg"/><title>Gold prices slip for the week as oil gains offset weaker dollar, U.S. bond rally</title><pubDate>2026-10-16 21:15:59</pubDate><author>Investing.com</author><link>https://www.investing.com/news/commodities-news/gold-4952940</link></item>
</channel></rss>`;

describe("RSS", () => {
  it("parses Google News: strips the source suffix, drops a description that repeats the title", () => {
    const items = parseRss(GOOGLE, "Google News");
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ title: "Gold Price Slides on Hot Inflation, but Schiff Says It’s a Gift", source: "Yahoo Finance", snippet: "", link: "https://news.google.com/rss/articles/abc?oc=5" });
    expect(items[0].publishedAt).toBe(Date.parse("2026-10-17T11:13:21Z") / 1000);
  });

  it("handles CDATA, double-escaped entities, HTML in the description, and the fallback source", () => {
    const [, b] = parseRss(GOOGLE, "Google News");
    expect(b.title).toBe("Fed's Powell signals rate cuts & patience");
    expect(b.snippet).toBe("Chair says policy is restrictive.");
    expect(b.source).toBe("Google News");
  });

  it("rejects non-http(s) links and empty titles", () => {
    const links = parseRss(GOOGLE, "G").map((i) => i.link);
    expect(links.some((l) => l.startsWith("javascript"))).toBe(false);
    expect(links).not.toContain("https://example.com/empty");
  });

  it("parses Investing.com (author as source, bare date treated as UTC)", () => {
    const [it0] = parseRss(INVESTING, "Investing.com");
    expect(it0.source).toBe("Investing.com");
    expect(it0.publishedAt).toBe(Date.parse("2026-10-16T21:15:59Z") / 1000);
  });

  it("parses dates and rejects invalid ones", () => {
    expect(parseRssDate("2026-10-17 17:48:59")).toBe(Date.parse("2026-10-17T17:48:59Z") / 1000);
    expect(parseRssDate("bukan tanggal")).toBeNull();
    expect(parseRssDate(null)).toBeNull();
    expect(plainText("a &#x26; b &#38; c&nbsp;d")).toBe("a & b & c d");
  });

  it("dedupes across sources by title, keeping the earliest version", () => {
    const a = { title: "Gold hits record high!", link: "https://a", source: "A", publishedAt: 200, snippet: "" };
    const b = { ...a, title: "Gold Hits Record High", link: "https://b", source: "B", publishedAt: 100 };
    const c = { ...a, title: "Dollar slips", link: "https://c", publishedAt: 300 };
    expect(dedupeNews([a, b, c]).map((x) => x.link)).toEqual(["https://c", "https://b"]);
  });
});

describe("relevance & classification", () => {
  it("keyword relevance gate", () => {
    expect(isGoldRelevant("Gold steadies near $4,160")).toBe(true);
    expect(isGoldRelevant("Powell speaks on policy")).toBe(true);
    expect(isGoldRelevant("Apple unveils new iPhone")).toBe(false);
  });

  const cases: [string, "bullish" | "bearish" | "neutral"][] = [
    ["Gold Price Slides on Hot Inflation, but Schiff Says It's a Gift", "bearish"],
    ["Fed signals rate cuts ahead as labor market cools", "bullish"],
    ["Dollar strengthens as Treasury yields rise after strong payrolls beat", "bearish"],
    ["Gold jumps to record high on safe-haven demand amid Middle East tensions", "bullish"],
    ["Gold falls as ceasefire eases tensions", "bearish"],
    ["Fed rules out rate cuts this year", "bearish"],
    ["Central banks keep buying gold, WGC says", "bullish"],
    ["CPI cools more than expected in September", "bullish"],
    ["Gold traders await Powell speech", "neutral"],
    ["U.S. dollar snaps four-week win streak, helping the euro halt a five-week slide", "bullish"],
    ["Canadian dollar heads for weekly gain as U.S. dollar retreats", "bullish"],
    ["Australian dollar rises on strong jobs data", "neutral"],
    ["US PPI hotter than expected in September", "bearish"],
    ["Producer prices cool more than expected", "bullish"],
  ];
  for (const [title, label] of cases) {
    it(`${label}: ${title}`, () => expect(classifyGoldImpact(title).label).toBe(label));
  }

  it("flags conflicting drivers and never reports 'sedang' confidence on a conflict", () => {
    const r = classifyGoldImpact("Gold prices slip for the week as oil gains offset weaker dollar, U.S. bond rally");
    expect(r.conflict).toBe(true);
    expect(r.label).toBe("bullish"); // pendorong (USD lemah, bond rally) > laporan harga turun
    expect(r.confidence).toBe("rendah");
    expect(r.strength).toBe("lemah");
    expect(explainImpact(r)).toMatch(/^BUY XAUUSD \(bias lemah\): .*Faktor berlawanan: Laporan harga: emas sedang melemah/);
  });

  it("≥2 pendorong searah tanpa lawan → bias kuat (confidence tinggi)", () => {
    const r = classifyGoldImpact("Dollar slips and Treasury yields fall after weak jobs report");
    expect(r).toMatchObject({ label: "bullish", bias: "BUY", strength: "kuat", confidence: "tinggi", conflict: false });
    expect(r.ruleIds).toEqual(expect.arrayContaining(["usd_weak", "yields_down", "us_data_weak"]));
  });

  // judul nyata 20–27 Okt 2026 yang dulu salah/netral
  const v2: [string, "BUY" | "SELL" | "NETRAL"][] = [
    ["EUR/USD Edges Lower Ahead of FOMC and ECB Rate Decisions", "SELL"], // dulu BUY: "usd" di EUR/USD terbaca USD turun
    ["Sterling today: Pound slips as dollar holds firm ahead of Fed decision", "SELL"],
    ["FX Daily: Dollar buying returns ahead of FOMC", "SELL"],
    ["Dollar Index Keeps Firm Tone Ahead on FOMC Meeting", "SELL"],
    ["Ringgit Opens Higher Against US Dollar Ahead Of FOMC Meeting", "BUY"],
    ["Yen rallies as dollar wobbles toward Fed meeting", "BUY"],
    ["British Pound edges higher vs weak USD ahead key FOMC event risk", "BUY"],
    ["Federal Reserve to Hold Rates in October, Weigh December Hike", "SELL"],
    ["Rabobank Forecast: Federal Reserve May Hike Another 25 Basis Points in December, With Rate Cuts Not Until 2028", "SELL"], // dulu BUY
    ["AI debt trouble could help Fed's Warsh get his way with fewer rate hikes", "BUY"],
    ["Federal Reserve Votes Unanimously to Raise Rates 25 Basis Points to 3.75%-4.00%", "SELL"],
    ["Why Goldman Sachs expects Fed to skip October rate hike", "NETRAL"],
    ["Fed holds interest rates steady as inflation hits 3-year high", "SELL"],
    ["U.S. Treasury yields hover near multi-week lows ahead of Fed decision", "BUY"],
    ["Gold slips ahead of Fed decision; Iran diplomacy hopes in focus", "SELL"],
    ["Gold trades above $4,000 as FOMC decision keeps USD bulls on hold", "NETRAL"],
    ["Australian Dollar bulls hesitant below one-month top before CPI, FOMC", "NETRAL"],
    ["Gold price today: Gold prices down 5.2% YOY one week ahead of the Fed's rate decision", "NETRAL"],
  ];
  for (const [title, bias] of v2) {
    it(`v2 ${bias}: ${title}`, () => expect(classifyGoldImpact(title).bias).toBe(bias));
  }

  it("de-eskalasi tidak terbaca sebagai risiko geopolitik", () => {
    const r = classifyGoldImpact("Gold rebounds on easing geopolitical tensions and stalls: eyes on US CPI");
    expect(r.ruleIds).toContain("risk_on");
    expect(r.ruleIds).not.toContain("safe_haven");
  });

  it("alasan mengutip frasa pemicu; penjelasan diawali arah & kekuatan", () => {
    const r = classifyGoldImpact("Forex Today: US Dollar holds ground ahead of mid-tier data releases, FOMC meeting");
    expect(r).toMatchObject({ bias: "SELL", strength: "sedang", confidence: "sedang" });
    expect(r.reasons[0]).toMatch(/^USD menguat .* — “US Dollar holds ground”$/);
    expect(explainImpact(r)).toMatch(/^SELL XAUUSD \(bias sedang\): USD menguat/);
  });

  it("judul pertanyaan hanya bias lemah", () => {
    expect(classifyGoldImpact("October 2026 FOMC Meeting Preview: Will the Fed Raise Rates Again?")).toMatchObject({ bias: "SELL", strength: "lemah" });
  });

  it("data harga negara lain bukan topik PPI/CPI AS", () => {
    for (const t of ["Spain's producer prices up 18.3% in September", "Producer prices in Brazil rise 1.54% in September", "S. Korea's Producer Prices Rise for Second Month as Cabbage Prices Surge 42.9%", "Bosnia's industrial PPI up 5.5% y/y in Sept", "U.K. lumber producer prices match highest level in 12 months"]) expect(newsTopic(t)).toBeNull();
    expect(newsTopic("US producer prices rise 6.3%, fastest since 2022")).toBe("PPI");
    expect(newsTopic("U.S. producer prices post biggest annual gain since December 2022")).toBe("PPI");
  });

  it("negation flips the rule direction and is visible in the reason", () => {
    const r = classifyGoldImpact("Fed delays rate cut as inflation stays sticky");
    expect(r.ruleIds).toContain("fed_dovish:neg");
    expect(r.reasons[0]).toMatch(/^Kebalikan dari/);
  });

  it("explanation for neutral with no drivers", () => {
    expect(explainImpact(classifyGoldImpact("Gold traders await Powell speech"))).toMatch(/^Netral: tidak terdeteksi/);
  });

  it("Fed policy filter keeps FOMC releases, drops bank enforcement/approvals", () => {
    expect(FED_POLICY.test("Federal Reserve issues FOMC statement")).toBe(true);
    expect(FED_POLICY.test("Minutes of the Federal Open Market Committee, September 15-16")).toBe(true);
    expect(FED_POLICY.test("Federal Reserve Board announces approval of application by BancFirst Corporation")).toBe(false);
    expect(FED_POLICY.test("Federal Reserve Board issues enforcement action with Ontario Bancorporation, Inc.")).toBe(false);
  });

  it("cosine", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe("topic focus: FOMC, NFP, CPI, PPI", () => {
  const cases: [string, string | null][] = [
    ["Federal Reserve issues FOMC statement", "FOMC"],
    ["Analysis: Everyone expects the Fed to hold rates in October", "FOMC"],
    ["Fed cuts rates by 25 basis points, signals more easing", "FOMC"],
    ["US nonfarm payrolls rise 150,000 in September", "NFP"],
    ["Dollar slips after weak jobs report", "NFP"],
    ["ADP private payrolls fall unexpectedly", null],
    ["ADP employment drops ahead of Friday's nonfarm payrolls", "NFP"],
    ["Gold Price Slides on Hot Inflation", null],
    ["US CPI rises 0.4% in September, core inflation sticky", "CPI"],
    ["Consumer prices jump more than expected", "CPI"],
    ["UK CPI hits 4% as Bank of England weighs hike", null],
    ["US producer prices rise 0.6%", "PPI"],
    ["PPI cools, easing pressure on the Fed", "PPI"],
    ["Gold steadies near $4,160 as traders eye earnings", null],
    ["Federal Reserve Board announces approval of application by BancFirst Corporation", null],
  ];
  for (const [title, topic] of cases) it(`${topic ?? "—"}: ${title}`, () => expect(newsTopic(title)).toBe(topic));

  it("calendar titles", () => {
    expect(calendarTopic("CPI m/m")).toBe("CPI");
    expect(calendarTopic("Core CPI y/y")).toBe("CPI");
    expect(calendarTopic("Core PPI m/m")).toBe("PPI");
    expect(calendarTopic("Non-Farm Employment Change")).toBe("NFP");
    expect(calendarTopic("Unemployment Rate")).toBe("NFP");
    expect(calendarTopic("Average Hourly Earnings m/m")).toBe("NFP");
    expect(calendarTopic("ADP Non-Farm Employment Change")).toBeNull();
    expect(calendarTopic("Federal Funds Rate")).toBe("FOMC");
    expect(calendarTopic("FOMC Meeting Minutes")).toBe("FOMC");
    expect(calendarTopic("Retail Sales m/m")).toBeNull();
    expect(calendarTopic("Fed Chairman Warsh Speaks")).toBeNull();
    expect(calendarTopic("FOMC Member Waller Speaks")).toBeNull();
    expect(calendarTopic("FOMC Statement")).toBe("FOMC");
    expect(calendarTopic("FOMC Press Conference")).toBe("FOMC");
    expect(calendarTopic("FOMC Economic Projections")).toBe("FOMC");
    expect(calendarTopic("Unemployment Claims")).toBeNull();
  });
});

describe("economic calendar", () => {
  const FF = [
    { title: "Bank Holiday", country: "USD", date: "2026-10-12T07:00:00-04:00", impact: "Holiday", forecast: "", previous: "" },
    { title: "CPI m/m", country: "USD", date: "2026-10-15T08:30:00-04:00", impact: "High", forecast: "0.3%", previous: "0.4%" },
    { title: "Retail Sales m/m", country: "USD", date: "2026-10-15T08:30:00-04:00", impact: "Medium", forecast: "0.2%", previous: "" },
    { title: "GDP q/q", country: "GBP", date: "2026-10-15T02:00:00-04:00", impact: "High", forecast: "0.1%", previous: "0.2%" },
    { title: "Broken", country: "USD", date: "not-a-date", impact: "High" },
    "junk",
  ];

  it("keeps only USD High/Medium with a valid date; no 'actual' field exists", () => {
    const ev = parseFfCalendar(FF);
    expect(ev.map((e) => e.title)).toEqual(["CPI m/m", "Retail Sales m/m"]);
    expect(ev[0]).toMatchObject({ impact: "High", forecast: "0.3%", previous: "0.4%", timeSec: Date.parse("2026-10-15T12:30:00Z") / 1000 });
    expect(ev[1].previous).toBeNull();
    expect("actual" in ev[0]).toBe(false);
    expect(parseFfCalendar({ not: "array" })).toEqual([]);
  });

  it("alert window: only High impact, not yet passed, within N minutes", () => {
    const ev = parseFfCalendar(FF);
    const t = Date.parse("2026-10-15T12:30:00Z") / 1000;
    expect(eventsInAlertWindow(ev, t - 31 * 60, 30)).toHaveLength(0);
    expect(eventsInAlertWindow(ev, t - 30 * 60, 30).map((e) => e.title)).toEqual(["CPI m/m"]);
    expect(eventsInAlertWindow(ev, t, 30)).toHaveLength(0); // sudah rilis
    expect(newsEventTitle(ev[0], t - 30 * 60)).toBe("⚠️ NEWS CPI 30 menit lagi: CPI m/m (USD)");
    expect(newsEventBody(ev[0])).toMatch(/^forecast 0.3%, previous 0.4%\./);
  });
});

describe("newsBlackoutAt", () => {
  const t = 1_800_000_000;
  const ev = [
    { title: "Retail Sales m/m", timeSec: t + 300 },
    { title: "Core CPI m/m", timeSec: t + 25 * 60 },
    { title: "FOMC Statement", timeSec: t - 20 * 60 },
  ];
  it("hanya topik FOMC/NFP/CPI/PPI dalam ±N menit", () => {
    expect(newsBlackoutAt(ev, t, 30)?.title).toBe("Core CPI m/m");
    expect(newsBlackoutAt(ev.slice(0, 1), t, 30)).toBeNull(); // Retail Sales bukan topik
    expect(newsBlackoutAt(ev.slice(2), t, 30)?.title).toBe("FOMC Statement"); // 20 menit setelah rilis
    expect(newsBlackoutAt(ev.slice(2), t, 15)).toBeNull();
  });
});
