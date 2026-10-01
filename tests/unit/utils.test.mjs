import { test } from 'node:test';
import assert from 'node:assert/strict';
import { html, trusted, esc, isoDate, addDays, parseISODate, dateRange, mealTypeForTime, uuid } from '../../js/lib/utils.js';

test('html`` escapes interpolated values (XSS)', () => {
  const evil = '<img src=x onerror="alert(1)">';
  const out = html`<div title="${evil}">${evil}</div>`.toString();
  assert.ok(!out.includes('<img'));
  assert.ok(out.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
  assert.equal(html`<b>${html`<i>${'<x>'}</i>`}</b>`.toString(), '<b><i>&lt;x&gt;</i></b>');
  assert.equal(html`${['<a>', trusted('<br>')]}`.toString(), '&lt;a&gt;<br>');
  assert.equal(html`${null}${false}${0}`.toString(), '0');
  assert.equal(esc("'`"), '&#39;&#96;');
});

test('local calendar dates', () => {
  assert.equal(isoDate(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(addDays('2026-03-31', 1), '2026-04-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(parseISODate('2026-09-29').getDate(), 29);
  assert.deepEqual(dateRange('2026-09-29', '2026-10-01'), ['2026-09-29', '2026-09-30', '2026-10-01']);
});

test('meal type by time of day', () => {
  const at = (h) => mealTypeForTime(new Date(2026, 8, 29, h));
  assert.deepEqual([at(8), at(13), at(17), at(21)], ['breakfast', 'lunch', 'snack', 'dinner']);
});

test('uuid v4 format', () => {
  assert.match(uuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
