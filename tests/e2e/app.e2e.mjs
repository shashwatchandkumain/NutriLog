// End-to-end browser tests against a mocked Supabase backend.
//   node --test tests/e2e/
// The app is served under /NutriLog/ (like GitHub Pages) with a test config.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { MockSupabase, MOCK_URL } from './mock-backend.mjs';
import { addDays, today, isoDate } from '../../js/lib/utils.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const TEST_CONFIG = `export const CONFIG = { SUPABASE_URL: '${MOCK_URL}', SUPABASE_ANON_KEY: 'test-anon-key', ENABLE_GOOGLE_AUTH: false };\n`;
const SHOTS = process.env.E2E_SCREENSHOTS;

let server, base, browser, backend;
const consoleErrors = [];

before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/NutriLog/')) { res.writeHead(404); return res.end('not found'); }
    let rel = decodeURIComponent(url.pathname.slice('/NutriLog/'.length)) || 'index.html';
    if (rel.endsWith('/')) rel += 'index.html';
    if (rel === 'js/config.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(TEST_CONFIG); }
    const file = normalize(join(ROOT, rel));
    if (!file.startsWith(ROOT) || rel.startsWith('node_modules') || rel.startsWith('.git')) { res.writeHead(403); return res.end(); }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch { res.writeHead(404); res.end('not found'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/NutriLog/`;
  browser = await chromium.launch();
  backend = new MockSupabase();
});

after(async () => {
  await browser?.close();
  server?.close();
});

/**
 * A fake Cult smart scale behind navigator.bluetooth: after connecting it streams real 11-byte
 * frames — settling, a locked 68.95 kg, then a heart rate of 74 bpm.
 */
const FAKE_SCALE = () => {
  const frame = (kg, hr = 0, settling = false) => {
    const raw = Math.round(kg * 100);
    const b = new Uint8Array([0xcf, hr, 0xc0, raw & 255, raw >> 8, 0x5a, 0x11, 0x3c, 0, settling ? 1 : 0, 0]);
    for (let i = 0; i < 10; i++) b[10] ^= b[i];
    return new DataView(b.buffer);
  };
  class Characteristic extends EventTarget {
    async startNotifications() {
      const seq = [frame(0), frame(41.2, 0, true), frame(68.9, 0, true), frame(68.95, 0, true), frame(68.95, 0, true), frame(68.95, 0, true), frame(68.95, 74), frame(68.95, 74), frame(68.95, 74)];
      seq.forEach((v, i) => setTimeout(() => { this.value = v; this.dispatchEvent(new Event('characteristicvaluechanged')); }, 120 * (i + 1)));
      return this;
    }
    async stopNotifications() { return this; }
  }
  const device = new EventTarget();
  device.name = 'Cult Smart Scale';
  device.gatt = {
    connected: false,
    async connect() { this.connected = true; return { getPrimaryService: async () => ({ getCharacteristic: async () => new Characteristic() }) }; },
    disconnect() { this.connected = false; },
  };
  Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: { requestDevice: async () => device } });
};

async function newDevice({ viewport = { width: 390, height: 844 }, colorScheme = 'light', scale = false } = {}) {
  const ctx = await browser.newContext({ viewport, colorScheme, acceptDownloads: true, serviceWorkers: 'block' });
  if (scale) await ctx.addInitScript(FAKE_SCALE);
  await ctx.route(`${MOCK_URL}/**`, (r) => backend.handle(r));
  await ctx.routeWebSocket(/mock\.supabase\.co/, (ws) => backend.realtime(ws));
  await ctx.route('https://world.openfoodfacts.org/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    status: 1, product: { product_name: 'Test Oats', brands: 'Acme', serving_quantity: 40, serving_size: '40 g', nutriments: { 'energy-kcal_100g': 379, proteins_100g: 13.2, carbohydrates_100g: 67.7, fat_100g: 6.5, fiber_100g: 10.1 } },
  }) }));
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  return { ctx, page };
}

/** Saves a screenshot when E2E_SCREENSHOTS is set: the full page, or the viewport while a sheet is open. */
async function shot(page, name) {
  if (!SHOTS) return;
  const sheetOpen = await page.locator('#modal-root .overlay').count();
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: !sheetOpen, animations: 'disabled' });
}
const EMAIL = 'asha@example.com';
const PASSWORD = 'correct-horse-9';
let device1;

test('first visit shows the welcome screen — no API keys or Supabase setup', async () => {
  device1 = await newDevice({ scale: true });
  const { page } = device1;
  await page.goto(base);
  await page.getByRole('link', { name: 'Create account' }).waitFor();
  const text = await page.locator('body').innerText();
  assert.match(text, /Your personal nutrition companion/);
  assert.doesNotMatch(text, /api key|anon key|supabase url/i);
  assert.equal(await page.locator('input[type=password]').count(), 0);
  await shot(page, '01-welcome');
});

const TARGET_DATE = addDays(today(), 120);

test('create account → onboarding with a target date → dashboard with zero state', async () => {
  const { page } = device1;
  await page.getByRole('link', { name: 'Create account' }).click();
  await page.getByLabel('Name').fill('Asha');
  await page.getByLabel('Email').fill(EMAIL);
  await page.locator('#su-password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();

  await page.getByRole('heading', { name: "Let's set up your profile" }).waitFor();
  await shot(page, '02-onboarding');
  await page.getByLabel('Age').fill('30');
  await page.getByLabel('Sex (for BMR)').selectOption('female');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Height').fill('165');
  await page.getByLabel('Current weight').fill('70');
  await page.getByLabel('Target weight (optional)').fill('64');
  await page.getByLabel('Reach my target by').fill(TARGET_DATE);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: /Lose weight/ }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: /Lightly active/ }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: /^Vegetarian/ }).click();
  await page.getByRole('button', { name: 'See my plan' }).click();

  await page.getByRole('heading', { name: 'Your daily plan' }).waitFor();
  // Mifflin–St Jeor: 10·70 + 6.25·165 − 5·30 − 161 = 1420.25; × 1.375 = 1952.84
  // Target date: −6 kg × 7,700 kcal ÷ 120 days = −385 kcal/day → 1567.84 → 1,568 (not rounded to tens)
  const plan = await page.locator('main').innerText();
  assert.match(plan, /1,420\.3 kcal/);
  assert.match(plan, /TDEE 1,952\.8 kcal/);
  assert.match(plan, /1,568 kcal/);
  assert.match(plan, /120 days\), eat 385 kcal a day below your TDEE/);
  await shot(page, '03-plan');
  await page.getByRole('button', { name: 'Start tracking' }).click();
  await page.getByRole('button', { name: 'Create my recovery code' }).click();
  await page.getByText('NUTRI-AB2C-DE3F').waitFor();
  await page.getByRole('button', { name: /I've saved it/ }).click();

  await page.getByRole('heading', { name: /Good (morning|afternoon|evening), Asha/ }).waitFor();
  await page.getByText('No meals logged today').waitFor();
  const hero = await page.locator('#d-hero').innerText();
  assert.match(hero, /1,568/);
  assert.equal((await page.locator('#d-hero .hero-stat .v').first().innerText()).trim(), '0');
  const saved = backend.db.profiles.find((p) => p.display_name === 'Asha');
  assert.equal(saved.onboarding_completed, true);
  assert.equal(saved.target_date, TARGET_DATE);
  assert.equal(backend.db.daily_goals.find((g) => g.user_id === saved.id).calories, 1568);
  await page.waitForFunction(() => document.querySelector('#d-weight')?.innerText.includes('70 kg'));
  await shot(page, '04-dashboard-empty');
});

test('add food opens straight to AI; the Analyze button is compact', async () => {
  const { page } = device1;
  await page.locator('.launch-bar').click();
  await page.getByRole('tab', { name: /Analyze with AI/ }).waitFor();
  assert.equal(await page.getByRole('tab', { name: 'Search' }).count(), 0, 'the food database search is gone');
  const box = await page.locator('#fl-analyze').boundingBox();
  assert.ok(box.height <= 52, `Analyze button is ${box.height}px tall`);
  const icon = await page.locator('#fl-analyze svg').boundingBox();
  assert.ok(icon.width <= 20 && icon.height <= 20, `icon is ${icon.width}×${icon.height}`);
  await shot(page, '05-add-food');
});

test('describe with AI → review → adjust grams → totals are consistent', async () => {
  const { page } = device1;
  await page.getByLabel('What did you eat?').fill('1 katori dal tadka and jeera rice');
  await page.getByRole('button', { name: 'Analyze' }).click();
  await page.getByRole('heading', { name: 'Review & add' }).waitFor();
  await page.getByText('Estimated by Gemini').waitFor();
  await page.getByLabel('Grams of Jeera rice').fill('200');
  await page.getByLabel('Grams of Jeera rice').press('Tab');
  await page.getByText(/302 kcal/).first().waitFor(); // (3·4 + 28·4 + 3·9) = 151 kcal/100 g × 200 g
  await shot(page, '06-ai-review');
  await page.getByRole('button', { name: 'Add 2 items' }).click();
  await page.locator('.item', { hasText: 'Jeera rice' }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.item.pending'));
  const total = backend.db.meal_items.reduce((s, i) => s + i.calories, 0);
  assert.equal(total, 193.5 + 302);
  assert.equal((await page.locator('#d-hero .hero-stat .v').first().innerText()).trim(), '496');
  const macros = await page.locator('#d-macros').innerText();
  const protein = backend.db.meal_items.reduce((s, i) => s + i.protein, 0);
  assert.match(macros, new RegExp(`${Math.round(protein * 10) / 10}`));
});

test('AI failure shows a friendly message, not a raw error', async () => {
  const { page } = device1;
  backend.aiFailures = 1;
  await page.locator('.launch-bar').click();
  await page.getByLabel('What did you eat?').fill('pizza');
  await page.getByRole('button', { name: 'Analyze' }).click();
  await page.locator('.toast.error', { hasText: 'AI is unavailable right now' }).waitFor();
  await page.keyboard.press('Escape');
});

test('edit an item and water tracking', async () => {
  const { page } = device1;
  await page.locator('.item', { hasText: 'Dal tadka' }).click();
  await page.getByLabel('Amount').fill('300');
  await page.getByText(/New total: 387 kcal/).waitFor();
  await page.getByRole('button', { name: 'Save' }).click();
  await page.waitForFunction(() => document.querySelector('#d-hero').innerText.includes('689'));
  await page.getByRole('button', { name: 'Add a glass' }).click();
  await page.getByRole('button', { name: 'Add a glass' }).click();
  await page.waitForFunction(() => document.querySelector('#d-water').innerText.includes('500 ml'));
  await page.waitForTimeout(600);
  assert.equal(backend.db.water_logs[0].glasses, 2);
  assert.equal(backend.db.meal_items.find((i) => i.food_name === 'Dal tadka').calories, 387);
  await shot(page, '07-dashboard-logged');
});

test('smart scale: measure over Bluetooth, see body composition, log it, targets follow', async () => {
  const { page } = device1;
  await page.locator('.qa', { hasText: 'Measure' }).click();
  await page.getByRole('heading', { name: 'Measurement complete' }).waitFor();
  const result = await page.locator('.sheet').innerText();
  assert.match(result, /68\.95\s*kg/);
  assert.match(result, /74\s*bpm/);
  // BMI 68.95 / 1.65² = 25.33; body fat (Deurenberg, female, 30) = 1.2·25.33 + 0.23·30 − 5.4 = 31.9%
  assert.match(result, /25\.3/);
  assert.match(result, /31\.9%/);
  await shot(page, '08-scale-result');
  await page.getByRole('button', { name: 'Log this' }).click();
  await page.locator('.toast', { hasText: 'Targets updated for 68.95 kg: 1,621 kcal a day.' }).waitFor();
  const w = backend.db.weight_history.find((x) => x.recorded_on === today());
  assert.equal(w.weight_kg, 68.95);
  assert.equal(w.source, 'scale');
  assert.equal(w.heart_rate_bpm, 74);
  assert.equal(w.body_fat_pct, 31.89);
  // New weight → TDEE 1938.41; −4.95 kg × 7,700 ÷ 120 days = −317.6 → 1,621 kcal (automatic targets)
  assert.equal(backend.db.daily_goals.find((g) => g.calories).calories, 1621);
  await page.waitForFunction(() => document.querySelector('#d-weight')?.innerText.includes('68.95 kg'));
  assert.match(await page.locator('#d-weight').innerText(), /31\.9% body fat · 74 bpm/);
});

test('reopening the site restores the session straight to the dashboard', async () => {
  const { page } = device1;
  await page.reload();
  await page.getByRole('heading', { name: /Asha/ }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Create account' }).count(), 0);
  await page.locator('.item', { hasText: 'Jeera rice' }).waitFor();
});

test('dark mode applies before first paint and persists', async () => {
  const { page } = device1;
  await page.getByRole('link', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'Dark' }).click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await page.reload();
  // theme-init.js runs in <head>, before the body is parsed.
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.equal(bg, 'rgb(13, 19, 21)');
  await page.getByRole('heading', { name: 'Settings' }).waitFor();
  await shot(page, '09-settings-dark');
  await page.getByRole('link', { name: 'Dashboard' }).first().click();
  await page.locator('.item', { hasText: 'Jeera rice' }).waitFor();
  await shot(page, '10-dashboard-dark');
  await page.getByRole('link', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'System' }).click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
});

test('progress page renders charts and body composition from real data', async () => {
  const { page } = device1;
  await page.getByRole('link', { name: 'Progress' }).first().click();
  await page.locator('#p-cal svg').waitFor();
  const tiles = await page.locator('#p-tiles').innerText();
  assert.match(tiles, /Current streak\s*1/);
  assert.match(tiles, /689/); // average of one logged day
  assert.match(tiles, /On track for/);
  const body = await page.locator('#p-body').innerText();
  assert.match(body, /31\.9/);
  assert.match(body, /74/);
  await shot(page, '11-progress');
});

test('calories page: treadmill uses ACSM MET and the weight on that day — and follows a new weigh-in', async () => {
  const { page } = device1;
  await page.getByRole('link', { name: 'Calories' }).first().click();
  await page.getByRole('button', { name: /Treadmill/ }).click();
  await page.getByLabel('Duration in minutes').fill('30');
  await page.getByLabel('Speed in km/h').fill('6');
  // ACSM walking: VO₂ = 3.5 + 0.1·100 = 13.5 → MET 3.86; (3.86 − 1) × 68.95 kg × 0.5 h = 98.6 kcal
  await page.getByText('≈ 98.6 kcal · MET 3.86 · at 68.95 kg').waitFor();
  await page.getByRole('button', { name: 'Log', exact: true }).click();
  await page.locator('#c-list .item', { hasText: 'Treadmill walk · 6 km/h' }).waitFor();
  await page.waitForTimeout(500);
  const act = backend.db.activities[0];
  assert.deepEqual([act.met, act.calories_burned, act.weight_kg], [3.86, 98.6, 68.95]);
  await shot(page, '12-calories');

  // A new weigh-in for today → the same 30 minutes is recalculated for 70.5 kg.
  await page.getByRole('link', { name: 'Dashboard' }).first().click();
  await page.getByRole('button', { name: '+ Log' }).click();
  await page.locator('#w-val').fill('70.5');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('link', { name: 'Calories' }).first().click();
  await page.locator('#c-list .item', { hasText: 'at 70.5 kg' }).waitFor();
  assert.match(await page.locator('#c-list').innerText(), /100\.8\s*kcal/); // 2.86 × 70.5 × 0.5 = 100.815
  await page.waitForTimeout(800);
  assert.equal(backend.db.activities[0].calories_burned, 100.82, 'the database recomputed it too');
});

test('Settings: choosing Claude sends food analysis to Claude', async () => {
  const { page } = device1;
  await page.getByRole('link', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'Claude', exact: true }).click();
  await page.locator('.toast', { hasText: 'AI model: Claude.' }).waitFor();
  assert.equal(backend.db.user_preferences.find((p) => p.ai_provider === 'claude')?.ai_provider, 'claude');
  await page.getByRole('link', { name: 'Dashboard' }).first().click();
  await page.locator('.launch-bar').click();
  await page.getByText('Estimated by Claude').waitFor();
  await page.getByLabel('What did you eat?').fill('dal rice');
  await page.getByRole('button', { name: 'Analyze' }).click();
  await page.getByText('Estimated by Claude.').waitFor();
  assert.equal(backend.lastProvider, 'claude');
  await page.keyboard.press('Escape');
});

test('import a smart-scale backup profile: weigh-ins added once, existing days kept', async () => {
  const { page } = device1;
  const at = (daysAgo) => { const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(9, 0, 0, 0); return d.toISOString(); };
  const backup = {
    version: 1, exportedAt: new Date().toISOString(), settings: [],
    profiles: [{ id: 1, name: 'Asha', sex: 'female', birthYear: new Date().getFullYear() - 30, heightCm: 165 }, { id: 2, name: 'Ravi', sex: 'male', birthYear: 1990, heightCm: 178 }],
    readings: [
      { id: 1, profileId: 1, ts: at(10), weightKg: 71.4, heartRate: 70 },
      { id: 2, profileId: 1, ts: at(5), weightKg: 70.85 },
      { id: 3, profileId: 1, ts: at(0), weightKg: 99 },   // today already has a weigh-in → kept as is
      { id: 4, profileId: 2, ts: at(3), weightKg: 80 },
    ],
  };
  const file = { name: 'occult_backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) };
  const importOnce = async () => {
    await page.getByRole('link', { name: 'Settings' }).first().click();
    await page.locator('[data-import]').click();
    await page.locator('#imp-file').setInputFiles(file);
    await page.getByRole('heading', { name: 'Import from smart scale' }).waitFor();
    await page.getByText(/2 new for you|0 new for you/).waitFor();
    await page.locator('.sheet').getByRole('button', { name: 'Import', exact: true }).click();
    await page.locator('.toast', { hasText: 'Imported' }).waitFor();
  };
  await importOnce();
  const mine = () => backend.db.weight_history.filter((w) => w.user_id === backend.db.profiles.find((p) => p.display_name === 'Asha').id);
  assert.equal(mine().length, 3);
  const old = mine().find((w) => w.recorded_on === isoDate(new Date(at(10))));
  assert.deepEqual([old.weight_kg, old.source, old.heart_rate_bpm], [71.4, 'import', 70]);
  assert.equal(mine().find((w) => w.recorded_on === today()).weight_kg, 70.5, "today's weigh-in is kept");
  await page.locator('.toast').first().waitFor({ state: 'detached', timeout: 10000 }).catch(() => {});
  await importOnce();
  assert.equal(mine().length, 3, 'importing the same file again adds nothing');
});

test('barcode lookup (manual entry) logs a serving', async () => {
  const { page } = device1;
  await page.getByRole('link', { name: 'Dashboard' }).first().click();
  await page.getByRole('button', { name: 'Barcode' }).click();
  await page.getByLabel('Barcode number').fill('8901234567890');
  await page.getByRole('button', { name: 'Look up' }).click();
  await page.getByText('Test Oats (Acme)').waitFor();
  assert.match(await page.getByLabel('Unit').locator('option:checked').innerText(), /1 serving/);
  await page.getByRole('button', { name: 'Add to log' }).click();
  await page.locator('.item', { hasText: 'Test Oats' }).waitFor();
  await page.waitForTimeout(500);
  const oats = backend.db.meal_items.find((i) => i.food_name.startsWith('Test Oats'));
  assert.equal(oats.calories, Math.round(379 * 0.4 * 100) / 100);
});

test('offline changes queue and sync exactly once', async () => {
  const { page, ctx } = device1;
  const before = backend.db.meal_items.length;
  await ctx.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.locator('.launch-bar').click();
  await page.getByRole('tab', { name: 'Manual' }).click();
  await page.locator('#m-name').fill('Banana');
  await page.locator('#m-cal').fill('105');
  await page.locator('#m-c').fill('27');
  await page.getByRole('button', { name: 'Add to log' }).click();
  await page.locator('#sync-pill', { hasText: 'Offline' }).waitFor();
  await page.locator('.item.pending', { hasText: 'Banana' }).waitFor();
  assert.equal(backend.db.meal_items.length, before);
  await ctx.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => !document.querySelector('.item.pending'));
  await page.waitForTimeout(500);
  assert.equal(backend.db.meal_items.filter((i) => i.food_name === 'Banana').length, 1);
  assert.equal(backend.db.meal_items.find((i) => i.food_name === 'Banana').calories, 105);
});

test('a second device sees the same data after logging in', async () => {
  const other = await newDevice({ viewport: { width: 1280, height: 900 } });
  await other.page.goto(`${base}#/login`);
  await other.page.getByLabel('Email').fill(EMAIL);
  await other.page.locator('#li-password').fill('wrong-password');
  await other.page.getByRole('button', { name: 'Log in' }).click();
  await other.page.getByRole('alert').filter({ hasText: 'Email or password is incorrect.' }).waitFor();
  await other.page.locator('#li-password').fill(PASSWORD);
  await other.page.getByRole('button', { name: 'Log in' }).click();
  await other.page.locator('.item', { hasText: 'Banana' }).waitFor();
  const n = await other.page.locator('#d-meals .item').count();
  assert.equal(n, backend.db.meal_items.length);
  await shot(other.page, '11-desktop-dashboard');
  const overflow = await other.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `desktop horizontal overflow ${overflow}px`);
  await other.ctx.close();
});

test('hidden status pills stay hidden', async () => {
  const visible = await device1.page.evaluate(() => { const p = document.getElementById('sync-pill'); return p && p.hidden ? getComputedStyle(p).display : 'n/a'; });
  assert.ok(visible === 'none' || visible === 'n/a');
});

test('no horizontal scrolling on a phone', async () => {
  const overflow = await device1.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `mobile horizontal overflow ${overflow}px`);
});

test('export, log out, recovery-code reset, and delete account', async () => {
  const { page } = device1;
  await page.getByRole('link', { name: 'Settings' }).first().click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'JSON' }).click()]);
  const json = JSON.parse(await (await import('node:fs/promises')).readFile(await download.path(), 'utf8'));
  assert.equal(json.meal_items.length, backend.db.meal_items.length);
  assert.equal(json.account.email, EMAIL);

  await page.getByRole('button', { name: 'Log out' }).click();
  await page.getByRole('link', { name: 'Create account' }).waitFor();

  await page.getByRole('link', { name: 'Log in' }).click();
  await page.getByRole('link', { name: 'Forgot password?' }).click();
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByRole('link', { name: 'Use a recovery code' }).click();
  await page.getByRole('heading', { name: 'Recover with a code' }).waitFor();
  assert.equal(await page.getByLabel('Email').inputValue(), EMAIL, 'email carries over from the previous screen');
  await page.getByLabel('Recovery code').fill('nutri ab2c de3f');
  await page.locator('#rc-password').fill('new-password-42');
  await page.getByRole('button', { name: /Reset password/ }).click();
  await page.getByRole('heading', { name: /Asha/ }).waitFor();

  await page.getByRole('link', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'Delete my account' }).click();
  const confirm = page.getByRole('button', { name: 'Delete forever' });
  assert.equal(await confirm.isDisabled(), true);
  await page.getByLabel('Type DELETE to confirm').fill('DELETE');
  await confirm.click();
  await page.getByRole('link', { name: 'Create account' }).waitFor();
  assert.equal(backend.db.meal_items.length, 0);
  assert.equal(backend.users.size, 0);
});

test('password-reset email link opens "choose a new password" and signs in', async () => {
  const { randomUUID } = await import('node:crypto');
  const user = { id: randomUUID(), email: 'reset@example.com', password: 'old-password-1', user_metadata: {}, created_at: new Date().toISOString() };
  backend.users.set(user.id, user);
  backend.createDefaults(user.id);
  const s = backend.session(user);
  const { page, ctx } = await newDevice();
  await page.goto(`${base}#access_token=${s.access_token}&expires_at=${s.expires_at}&expires_in=3600&refresh_token=${s.refresh_token}&token_type=bearer&type=recovery`);
  await page.getByRole('heading', { name: 'Choose a new password' }).waitFor();
  assert.doesNotMatch(await page.evaluate(() => location.hash), /access_token/, 'tokens are removed from the address bar');
  await page.locator('#np-password').fill('brand-new-pass-7');
  await page.getByLabel('Confirm password').fill('brand-new-pass-7');
  await page.getByRole('button', { name: 'Save password' }).click();
  await page.getByRole('heading', { name: "Let's set up your profile" }).waitFor(); // new user → onboarding
  assert.equal(user.password, 'brand-new-pass-7');
  await ctx.close();
});

test('an expired email link shows a friendly message', async () => {
  const { page, ctx } = await newDevice();
  await page.goto(`${base}#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`);
  await page.locator('.toast.error', { hasText: 'That link has expired' }).waitFor();
  await page.getByRole('link', { name: 'Create account' }).waitFor();
  await ctx.close();
});

test('no console errors during the whole run', () => {
  // Network failures while deliberately offline are expected; nothing else is. Handled,
  // user-caused failures (wrong password, AI down) are logged as warnings, not errors.
  const unexpected = consoleErrors.filter((e) => !/ERR_INTERNET_DISCONNECTED|Failed to load resource|net::ERR/.test(e));
  assert.deepEqual(unexpected, []);
});
