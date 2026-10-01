import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../../', import.meta.url).pathname;
const sw = readFileSync(join(root, 'sw.js'), 'utf8');
const shell = JSON.parse(`[${/const SHELL = \[([\s\S]*?)\];/.exec(sw)[1].replace(/'/g, '"').replace(/,\s*$/, '')}]`);
const walk = (dir) => readdirSync(join(root, dir)).flatMap((f) => (statSync(join(root, dir, f)).isDirectory() ? walk(`${dir}/${f}`) : [`${dir}/${f}`]));

test('service worker precaches every app module and asset it lists', () => {
  for (const f of walk('js')) assert.ok(shell.includes(`./${f}`), `sw.js SHELL is missing ./${f}`);
  for (const f of shell) if (f !== './') assert.ok(existsSync(join(root, f)), `sw.js lists a missing file ${f}`);
});

test('service worker never caches Supabase or API traffic', () => {
  assert.doesNotMatch(sw, /supabase\.co.*cache\.put/);
  assert.match(sw, /CDN_HOSTS = \['cdn\.jsdelivr\.net', 'fonts\.googleapis\.com', 'fonts\.gstatic\.com'\]/);
});

test('manifest icons exist and paths are relative (GitHub Pages sub-path)', () => {
  const m = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  assert.equal(m.start_url.startsWith('/'), false);
  assert.equal(m.scope, './');
  for (const i of m.icons) assert.ok(existsSync(join(root, i.src)), i.src);
  assert.ok(m.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
});

test('no absolute root paths or secrets in the website files', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /(src|href)="\/(?!\/)/, 'use relative paths so /NutriLog/ works');
  const files = ['index.html', 'manifest.json', 'sw.js', ...walk('js')];
  for (const f of files) {
    const text = readFileSync(join(root, f), 'utf8');
    assert.doesNotMatch(text, /AIza[0-9A-Za-z_-]{30,}/, `${f}: Google API key`);
    assert.doesNotMatch(text, /sk-ant-[A-Za-z0-9_-]{20,}/, `${f}: Anthropic key`);
    assert.doesNotMatch(text, /sb_secret_[A-Za-z0-9_-]{10,}/, `${f}: Supabase secret key`);
    assert.doesNotMatch(text, /"role"\s*:\s*"service_role"/, `${f}: service role`);
  }
});
