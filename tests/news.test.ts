import { describe, expect, it } from "vitest";
import {
  classifyGoldImpact,
  cosine,
  dedupeNews,
  eventsInAlertWindow,
  explainImpact,
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
  ];
  for (const [title, label] of cases) {
    it(`${label}: ${title}`, () => expect(classifyGoldImpact(title).label).toBe(label));
  }

  it("flags conflicting drivers and never reports 'sedang' confidence on a conflict", () => {
    const r = classifyGoldImpact("Gold prices slip for the week as oil gains offset weaker dollar, U.S. bond rally");
    expect(r.conflict).toBe(true);
    expect(r.label).toBe("bullish"); // pendorong (USD lemah, bond rally) > laporan harga turun
    expect(r.confidence).toBe("rendah");
    expect(explainImpact(r)).toMatch(/bertentangan/);
  });

  it("gives 'sedang' confidence for ≥2 drivers in the same direction", () => {
    const r = classifyGoldImpact("Dollar slips and Treasury yields fall after weak jobs report");
    expect(r).toMatchObject({ label: "bullish", confidence: "sedang", conflict: false });
    expect(r.ruleIds).toEqual(expect.arrayContaining(["usd_weak", "yields_down", "us_data_weak"]));
  });

  it("negation flips the rule direction and is visible in the reason", () => {
    const r = classifyGoldImpact("Fed delays rate cut as inflation stays sticky");
    expect(r.ruleIds).toContain("fed_dovish:neg");
    expect(r.reasons[0]).toMatch(/^Kebalikan dari/);
  });

  it("explanation for neutral with no drivers", () => {
    expect(explainImpact(classifyGoldImpact("Gold traders await Powell speech"))).toMatch(/^Netral: tidak terdeteksi/);
  });

  it("cosine", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
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
    expect(newsEventTitle(ev[0], t - 30 * 60)).toBe("⚠️ NEWS BESAR 30 menit lagi: CPI m/m (USD)");
    expect(newsEventBody(ev[0])).toMatch(/^forecast 0.3%, previous 0.4%\./);
  });
});
