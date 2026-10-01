// Renders the PNG app icons from icons/icon.svg and icons/icon-maskable.svg.
// Usage: node scripts/build-icons.mjs   (requires the dev dependency "playwright")
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const svg = readFileSync(new URL('../icons/icon.svg', import.meta.url), 'utf8');
const maskable = readFileSync(new URL('../icons/icon-maskable.svg', import.meta.url), 'utf8');
const out = [
  ['icons/icon-192.png', svg, 192], ['icons/icon-512.png', svg, 512],
  ['icons/icon-maskable-512.png', maskable, 512], ['icons/apple-touch-icon.png', maskable, 180],
];
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [file, src, size] of out) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${src.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  console.log('wrote', file);
}
await browser.close();
