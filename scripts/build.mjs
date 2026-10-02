// Builds the GitHub Pages site into _site/ and checks that it will work when served from a
// sub-path such as https://USER.github.io/NutriLog/. There is no bundling: files ship as they are.
//
//   npm run build                        → _site/
//   node scripts/build.mjs --stamp abc   → also sets the service-worker cache version in _site/sw.js
//   node scripts/build.mjs --check       → only run the checks (used by the tests)
//
// The build fails if:
//   • a file in the service worker's SHELL is missing, or a JS file is not in SHELL
//   • an import, index.html, manifest or stylesheet reference points at a missing file
//   • a reference is root-absolute ("/js/app.js"), which breaks under /NutriLog/
//   • a module is loaded from a host the Content-Security-Policy does not allow
//   • anything that looks like a secret key is about to be published
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const ROOT = arg('--root') ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '_site');
const CHECK_ONLY = process.argv.includes('--check');
const PUBLISH = ['index.html', 'manifest.json', 'sw.js', '.nojekyll', 'css', 'js', 'icons'];

const errors = new Set();
const warnings = [];
const fail = (msg) => errors.add(msg);
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const exists = (p) => existsSync(join(ROOT, p));

function walk(dir) {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const p = `${dir}/${name}`;
    return statSync(join(ROOT, p)).isDirectory() ? walk(p) : [p];
  });
}
const files = PUBLISH.flatMap((p) => (exists(p) && statSync(join(ROOT, p)).isDirectory() ? walk(p) : [p]));
for (const p of PUBLISH) if (!exists(p)) fail(`missing ${p}`);

const isExternal = (u) => /^(https?:|data:|blob:|mailto:|#)/.test(u);
const resolve = (from, ref) => relative(ROOT, join(ROOT, dirname(from), ref.split(/[?#]/)[0]));
function checkRef(from, ref) {
  if (!ref || isExternal(ref)) return;
  if (ref.startsWith('/')) return fail(`${from}: "${ref}" is root-absolute; use a relative path so the site works under /NutriLog/`);
  if (!exists(resolve(from, ref))) fail(`${from}: "${ref}" does not exist`);
}

// ── Content-Security-Policy ─────────────────────────────────────────────────
const indexHtml = read('index.html');
const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(indexHtml)?.[1] ?? '';
const directives = Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([k, ...v]) => [k, v]));
if (!csp) fail('index.html has no Content-Security-Policy');
const scriptSrc = directives['script-src'] ?? directives['default-src'] ?? [];
if (scriptSrc.some((s) => ["'unsafe-inline'", "'unsafe-eval'", '*'].includes(s))) fail(`CSP script-src is too permissive: ${scriptSrc.join(' ')}`);
if (!(directives['object-src'] ?? []).includes("'none'")) fail("CSP should set object-src 'none'");
const scriptAllowed = (url) => scriptSrc.some((s) => s.startsWith('https://') && url.startsWith(s));

// ── Service-worker app shell ────────────────────────────────────────────────
const sw = read('sw.js');
const shellSrc = /const SHELL = \[([\s\S]*?)\];/.exec(sw)?.[1];
if (!shellSrc) fail('sw.js: SHELL list not found');
const shell = shellSrc ? JSON.parse(`[${shellSrc.replace(/'/g, '"').replace(/,\s*$/, '')}]`) : [];
for (const entry of shell) {
  if (!entry.startsWith('./')) fail(`sw.js SHELL: "${entry}" must start with ./`);
  else if (entry !== './' && !exists(entry.slice(2))) fail(`sw.js SHELL: ${entry} does not exist`);
}
for (const f of files) if (f.endsWith('.js') && f.startsWith('js/') && !shell.includes(`./${f}`)) fail(`sw.js SHELL is missing ./${f} (it would not work offline)`);

// ── index.html ──────────────────────────────────────────────────────────────
for (const [, ref] of indexHtml.matchAll(/\s(?:src|href)="([^"]+)"/g)) {
  checkRef('index.html', ref);
  if (/<script[^>]+src="https:/.test(indexHtml) && ref.startsWith('https://') && /\.m?js(\?|$)/.test(ref) && !scriptAllowed(ref)) fail(`index.html: script ${ref} is blocked by the CSP`);
}
if (/<script(?![^>]*\ssrc=)[^>]*>\s*\S/.test(indexHtml)) fail('index.html: inline <script> blocks are blocked by the CSP; load a file instead');
if (/\son[a-z]+="/i.test(indexHtml)) fail('index.html: inline event handlers (onclick=…) are blocked by the CSP');

// ── manifest.json ───────────────────────────────────────────────────────────
try {
  const m = JSON.parse(read('manifest.json'));
  for (const key of ['id', 'start_url', 'scope']) if (typeof m[key] === 'string' && m[key].startsWith('/')) fail(`manifest.json: ${key} "${m[key]}" is root-absolute`);
  for (const icon of [...(m.icons ?? []), ...(m.shortcuts ?? []).flatMap((s) => s.icons ?? [])]) checkRef('manifest.json', icon.src);
  for (const s of m.shortcuts ?? []) if (s.url?.startsWith('/')) fail(`manifest.json: shortcut "${s.name}" url is root-absolute`);
  if (!m.icons?.some((i) => i.sizes === '512x512')) fail('manifest.json: a 512×512 icon is required to install the app');
} catch (e) {
  fail(`manifest.json is not valid JSON: ${e.message}`);
}

// ── JavaScript and CSS ──────────────────────────────────────────────────────
const IMPORT_RES = [
  /^\s*import\s+(?:[\w$*{}\s,]+?\s+from\s*)?['"]([^'"]+)['"]/gm,                        // import x from '…' / import '…'
  /^\s*export\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[\w$\s,]*\})\s*from\s*['"]([^'"]+)['"]/gm, // export { x } from '…'
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,                                                 // import('…')
];
for (const f of files.filter((p) => p.endsWith('.js') || p.endsWith('.css'))) {
  const src = read(f);
  if (f.endsWith('.js')) {
    for (const re of IMPORT_RES) {
      for (const [, spec] of src.matchAll(re)) {
        if (spec.startsWith('https://')) { if (!scriptAllowed(spec)) fail(`${f}: imports ${spec}, which the CSP blocks`); }
        else if (spec.startsWith('.') || spec.startsWith('/')) checkRef(f, spec);
        else fail(`${f}: bare import "${spec}" can't load in the browser without a bundler`);
      }
    }
  } else {
    for (const [, ref] of src.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) checkRef(f, ref);
  }
  for (const [m] of src.matchAll(/['"`]\/(?:js|css|icons)\/[^'"`]*['"`]|['"`]\/(?:index\.html|manifest\.json|sw\.js)['"`]/g)) {
    fail(`${f}: "${m.slice(1, -1)}" is root-absolute; use a relative path so the site works under /NutriLog/`);
  }
}

// ── Secrets ─────────────────────────────────────────────────────────────────
const SECRET_PATTERNS = [
  [/sb_secret_[A-Za-z0-9_-]{10,}/, 'a Supabase secret key'],
  [/AIza[0-9A-Za-z_-]{35}/, 'a Google (Gemini) API key'],
  [/sk-ant-[A-Za-z0-9_-]{10,}/, 'an Anthropic (Claude) API key'],
  [/postgres(?:ql)?:\/\/[^\s:'"]+:[^\s@'"]+@/, 'a database connection string with a password'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
];
function jwtRole(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).role; } catch { return null; }
}
for (const f of files) {
  if (/\.(png|jpe?g|webp|ico|woff2?)$/i.test(f)) continue;
  const src = read(f);
  for (const [re, what] of SECRET_PATTERNS) if (re.test(src)) fail(`${f} contains what looks like ${what}; it must not be published`);
  for (const [token] of src.matchAll(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g)) {
    if (jwtRole(token) !== 'anon') fail(`${f} contains a JWT with role "${jwtRole(token)}"; only the anon key may be published`);
  }
}
if (files.some((f) => /(^|\/)\.env/.test(f))) fail('a .env file would be published');
if (/YOUR-PROJECT|YOUR_ANON_KEY/.test(read('js/config.js'))) warnings.push('js/config.js still has placeholder values; the site will show the setup screen');

// ── Output ──────────────────────────────────────────────────────────────────
for (const w of warnings) console.warn(`⚠ ${w}`);
if (errors.size) {
  for (const e of errors) console.error(`✗ ${e}`);
  console.error(`\nBuild failed: ${errors.size} problem${errors.size === 1 ? '' : 's'}.`);
  process.exit(1);
}

const bytes = files.reduce((n, f) => n + statSync(join(ROOT, f)).size, 0);
if (CHECK_ONLY) {
  console.log(`✓ ${files.length} files (${(bytes / 1024).toFixed(0)} KB) ready to publish.`);
  process.exit(0);
}
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT);
for (const p of PUBLISH) cpSync(join(ROOT, p), join(OUT, p), { recursive: true });
const stamp = arg('--stamp');
if (process.argv.includes('--stamp')) {
  if (!/^[\w.-]{1,40}$/.test(stamp ?? '')) { console.error('--stamp needs a version like 1a2b3c4d'); process.exit(1); }
  const out = join(OUT, 'sw.js');
  writeFileSync(out, readFileSync(out, 'utf8').replace(/^const VERSION = '.*';/m, `const VERSION = '${stamp}';`));
}
console.log(`✓ Built _site/: ${files.length} files, ${(bytes / 1024).toFixed(0)} KB${stamp ? `, cache version ${stamp}` : ''}.`);
console.log(`  Checked ${shell.length} app-shell files, every import and asset reference, the CSP and the published files for secrets.`);
