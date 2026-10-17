// Membuat ikon PNG (PWA, Apple, favicon, badge notifikasi) dari logo SVG GOLDMARKET.
//   npx tsx scripts/gen-icons.ts
import { join } from "node:path";
import { chromium } from "playwright-core";

const OUT = join(import.meta.dirname, "..", "public");
const DEFS = `<defs>
  <linearGradient id="tile" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3d7bff"/><stop offset=".55" stop-color="#1a3fb8"/><stop offset="1" stop-color="#0b1a52"/></linearGradient>
  <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe39a"/><stop offset=".55" stop-color="#e8b84c"/><stop offset="1" stop-color="#b8862b"/></linearGradient>
</defs>`;
// "G" emas + garis tren — sama dengan src/components/Logo.tsx (viewBox 40×40)
const glyph = (paint: string, dot: string) => `
  <path d="M27.7 12.6 A10 10 0 1 0 30 21" fill="none" stroke="${paint}" stroke-width="3.6" stroke-linecap="round"/>
  <path d="M19.5 23.5 L23.5 19.5 L26 22 L31 16.5" fill="none" stroke="${paint}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="31.4" cy="9.2" r="1.7" fill="${dot}"/>`;

// Ubin membulat (favicon)
const tile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">${DEFS}
  <rect x="1" y="1" width="38" height="38" rx="11" fill="url(#tile)"/>
  <rect x="1.5" y="1.5" width="37" height="37" rx="10.5" fill="none" stroke="url(#gold)" stroke-opacity=".55"/>
  <path d="M2 14 Q20 4 38 12 V2 H2 Z" fill="#fff" opacity=".07"/>${glyph("url(#gold)", "#ffd36a")}</svg>`;
// Penuh (maskable/Apple): latar menutup seluruh kanvas, glyph di zona aman tengah (~62%)
const full = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">${DEFS}
  <rect width="40" height="40" fill="url(#tile)"/>
  <circle cx="20" cy="18" r="20" fill="#5b8cff" opacity=".12"/>
  <g transform="translate(20 20) scale(.8) translate(-21 -18.5)">${glyph("url(#gold)", "#ffd36a")}</g></svg>`;
// Badge Android: siluet putih di atas transparan
const badge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><g transform="translate(20 20) scale(1.15) translate(-20.5 -20)">${glyph("#fff", "#fff")}</g></svg>`;

const targets: [string, string, number][] = [
  ["icon-512.png", full, 512],
  ["icon-192.png", full, 192],
  ["apple-touch-icon.png", full, 180],
  ["favicon.png", tile, 64],
  ["badge-96.png", badge, 96],
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage();
for (const [name, svg, size] of targets) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: join(OUT, name), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  console.log("✓", name, size);
}
await browser.close();
