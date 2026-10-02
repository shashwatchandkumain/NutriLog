// The production build check (scripts/build.mjs): the real site passes, and a copy with a
// root-absolute import, a missing module and a leaked key is rejected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = (...args) => spawnSync(process.execPath, ['scripts/build.mjs', '--check', ...args], { encoding: 'utf8' });

test('the site passes the production build checks', () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
});

test('the build rejects broken paths, CSP-blocked modules and secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nutrilog-build-'));
  try {
    for (const p of ['index.html', 'manifest.json', 'sw.js', '.nojekyll', 'css', 'js', 'icons']) cpSync(p, join(dir, p), { recursive: true });
    const app = join(dir, 'js/app.js');
    writeFileSync(app, `import '/js/router.js';\nimport './missing.js';\nimport 'https://evil.example/x.js';\nconst k = 'AIza${'x'.repeat(35)}';\n${readFileSync(app, 'utf8')}`);
    const r = run('--root', dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /"\/js\/router\.js" is root-absolute/);
    assert.match(r.stderr, /"\.\/missing\.js" does not exist/);
    assert.match(r.stderr, /evil\.example.*CSP blocks/);
    assert.match(r.stderr, /Google \(Gemini\) API key/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
