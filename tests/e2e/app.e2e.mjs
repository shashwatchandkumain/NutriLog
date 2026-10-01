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

async function newDevice({ viewport = { width: 390, height: 844 }, colorScheme = 'light' } = {}) {
  const ctx = await browser.newContext({ viewport, colorScheme, acceptDownloads: true, serviceWorkers: 'block' });
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

const shot = (page, name) => (SHOTS ? page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }) : null);
const EMAIL = 'asha@example.com';
const PASSWORD = 'correct-horse-9';
let device1;

test('first visit shows the welcome screen — no API keys or Supabase setup', async () => {
  device1 = await newDevice();
  const { page } = device1;
  await page.goto(base);
  await page.getByRole('link', { name: 'Create account' }).waitFor();
  const text = await page.locator('body').innerText();
  assert.match(text, /Your personal nutrition companion/);
  assert.doesNotMatch(text, /api key|anon key|supabase url|gemini|claude/i);
  assert.equal(await page.locator('input[type=password]').count(), 0);
  await shot(page, '01-welcome');
});

test('create account → onboarding → dashboard with zero state', async () => {
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
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: /Lose weight/ }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: /Lightly active/ }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: /^Vegetarian/ }).click();
  await page.getByRole('button', { name: 'See my plan' }).click();

  await page.getByRole('heading', { name: 'Your daily plan' }).waitFor();
  // Mifflin–St Jeor: 10·70 + 6.25·165 − 5·30 − 161 = 1420.25 → 1,420; × 1.375 = 1952.8 → 1,953
  const plan = await page.locator('main').innerText();
  assert.match(plan, /1,420 kcal/);
  assert.match(plan, /TDEE 1,953 kcal/);
  // lose: −min(500, 20%·1952.8=390.6) → 1562.2 → rounded to 1,560
  assert.match(plan, /1,560 kcal/);
  await shot(page, '03-plan');
  await page.getByRole('button', { name: 'Start tracking' }).click();
  await page.getByRole('button', { name: 'Create my recovery code' }).click();
  await page.getByText('NUTRI-AB2C-DE3F').waitFor();
  await page.getByRole('button', { name: /I've saved it/ }).click();

  await page.getByRole('heading', { name: /Good (morning|afternoon|evening), Asha/ }).waitFor();
  await page.getByText('No meals logged today').waitFor();
  const hero = await page.locator('#d-hero').innerText();
  assert.match(hero, /1,560/);
  assert.match(hero, /eaten/i);
  assert.equal((await page.locator('#d-hero .hero-stat .v').first().innerText()).trim(), '0');
  const saved = backend.db.profiles.find((p) => p.display_name === 'Asha');
  assert.equal(saved.onboarding_completed, true);
  assert.equal(saved.diet_type, 'vegetarian');
  assert.equal(backend.db.daily_goals.find((g) => g.user_id === saved.id).calories, 1560);
  await page.waitForFunction(() => document.querySelector('#d-weight')?.innerText.includes('70 kg'));
  await shot(page, '04-dashboard-empty');
});

test('search roti → 2 medium rotis logs exactly 224 kcal', async () => {
  const { page } = device1;
  await page.locator('.search-launch').click();
  await page.getByLabel('Search foods').fill('chapati');
  await page.locator('.result', { hasText: 'Roti / Chapati' }).first().click();
  const unit = page.getByLabel('Unit');
  assert.match(await unit.locator('option:checked').innerText(), /medium roti \(40 g\)/);
  await page.getByLabel('Amount').fill('2');
  await page.locator('#q-preview').getByText('224').waitFor();
  await page.getByRole('button', { name: /Lunch/ }).click();
  await page.getByRole('button', { name: 'Add to log' }).click();
  await page.locator('.item', { hasText: 'Roti / Chapati' }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.item.pending'));
  const items = backend.db.meal_items;
  assert.equal(items.length, 1);
  assert.equal(items[0].calories, 224);
  assert.equal(items[0].grams, 80);
  assert.equal(items[0].meal_type, 'lunch');
  assert.equal(items[0].unit, 'medium roti');
  await page.locator('.item', { hasText: '2 medium roti · 80 g' }).waitFor();
  assert.equal((await page.locator('#d-hero .hero-stat .v').first().innerText()).trim(), '224');
});

test('describe with AI → review → adjust grams → totals are consistent', async () => {
  const { page } = device1;
  await page.getByRole('button', { name: 'Describe' }).click();
  await page.getByLabel('What did you eat?').fill('1 katori dal tadka and jeera rice');
  await page.getByRole('button', { name: 'Analyze' }).click();
  await page.getByRole('heading', { name: 'Review & add' }).waitFor();
  await page.getByLabel('Grams of Jeera rice').fill('200');
  await page.getByLabel('Grams of Jeera rice').press('Tab');
  await page.getByText(/300 kcal/).first().waitFor(); // 150 kcal/100 g × 200 g
  await shot(page, '05-ai-review');
  await page.getByRole('button', { name: 'Add 2 items' }).click();
  await page.locator('.item', { hasText: 'Jeera rice' }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.item.pending'));
  const total = backend.db.meal_items.reduce((s, i) => s + i.calories, 0);
  assert.equal(total, 224 + 195 + 300);
  assert.equal((await page.locator('#d-hero .hero-stat .v').first().innerText()).trim(), '719');
  const macros = await page.locator('#d-macros').innerText();
  const protein = backend.db.meal_items.reduce((s, i) => s + i.protein, 0);
  assert.match(macros, new RegExp(`${Math.round(protein * 10) / 10}`));
});

test('AI failure shows a friendly message, not a raw error', async () => {
  const { page } = device1;
  backend.aiFailures = 1;
  await page.getByRole('button', { name: 'Describe' }).click();
  await page.getByLabel('What did you eat?').fill('pizza');
  await page.getByRole('button', { name: 'Analyze' }).click();
  await page.locator('.toast.error', { hasText: 'AI is unavailable right now' }).waitFor();
  await page.keyboard.press('Escape');
});

test('edit an item and water tracking', async () => {
  const { page } = device1;
  await page.locator('.item', { hasText: 'Roti / Chapati' }).click();
  await page.getByLabel('Amount').fill('3');
  await page.getByText(/New total: 336 kcal/).waitFor();
  await page.getByRole('button', { name: 'Save' }).click();
  await page.waitForFunction(() => document.querySelector('#d-hero').innerText.includes('831'));
  await page.getByRole('button', { name: 'Add a glass' }).click();
  await page.getByRole('button', { name: 'Add a glass' }).click();
  await page.waitForFunction(() => document.querySelector('#d-water').innerText.includes('500 ml'));
  await page.waitForTimeout(600);
  assert.equal(backend.db.water_logs[0].glasses, 2);
  assert.equal(backend.db.meal_items.find((i) => i.food_name.startsWith('Roti')).calories, 336);
  await shot(page, '06-dashboard-logged');
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
  await shot(page, '07-settings-dark');
  await page.getByRole('link', { name: 'Dashboard' }).first().click();
  await page.locator('.item', { hasText: 'Jeera rice' }).waitFor();
  await shot(page, '08-dashboard-dark');
  await page.getByRole('link', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'System' }).click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
});

test('progress page renders charts from real data', async () => {
  const { page } = device1;
  await page.getByRole('link', { name: 'Progress' }).first().click();
  await page.locator('#p-cal svg').waitFor();
  const tiles = await page.locator('#p-tiles').innerText();
  assert.match(tiles, /Current streak\s*1/);
  assert.match(tiles, /831/); // average of one logged day
  await shot(page, '09-progress');
});

test('calories page: preset activity uses net MET calories', async () => {
  const { page } = device1;
  await page.getByRole('link', { name: 'Calories' }).first().click();
  await page.getByRole('button', { name: /Running/ }).click();
  await page.getByLabel('Duration in minutes').fill('30');
  // (9.8 − 1) × 70 kg × 0.5 h = 308
  await page.getByText('≈ 308 kcal').waitFor();
  await page.getByRole('button', { name: 'Log', exact: true }).click();
  await page.locator('#c-list .item', { hasText: 'Running' }).waitFor();
  await page.waitForTimeout(500);
  assert.equal(backend.db.activities[0].calories_burned, 308);
  await shot(page, '10-calories');
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
  await page.locator('.search-launch').click();
  await page.getByLabel('Search foods').fill('banana');
  await page.locator('.result', { hasText: 'Banana' }).first().click();
  await page.getByRole('button', { name: 'Add to log' }).click();
  await page.locator('#sync-pill', { hasText: 'Offline' }).waitFor();
  await page.locator('.item.pending', { hasText: 'Banana' }).waitFor();
  assert.equal(backend.db.meal_items.length, before);
  await ctx.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => !document.querySelector('.item.pending'));
  await page.waitForTimeout(500);
  assert.equal(backend.db.meal_items.filter((i) => i.food_name === 'Banana').length, 1);
  assert.equal(backend.db.meal_items.find((i) => i.food_name === 'Banana').calories, Math.round(89 * 1.18 * 100) / 100);
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
