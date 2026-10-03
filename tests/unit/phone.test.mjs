import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toE164, looksLikePhone, formatPhone } from '../../js/lib/phone.js';

test('phone numbers become E.164; Indian mobiles are checked', () => {
  assert.equal(toE164('+91', '98765 43210'), '+919876543210');
  assert.equal(toE164('+91', '098765-43210'), '+919876543210', 'leading 0');
  assert.equal(toE164('+91', '919876543210'), '+919876543210', 'country code typed again');
  assert.equal(toE164('+91', '+971 50 123 4567'), '+971501234567', 'a typed + keeps its own country code');
  assert.equal(toE164('+44', '7911 123456'), '+447911123456');
  assert.throws(() => toE164('+91', '12345'), /10-digit Indian mobile/);
  assert.throws(() => toE164('+91', '5876543210'), /10-digit Indian mobile/, 'Indian mobiles start with 6-9');
  assert.throws(() => toE164('+1', '12'), /valid mobile/);
});

test('login field: phone or email', () => {
  assert.equal(looksLikePhone('98765 43210'), true);
  assert.equal(looksLikePhone('+91 98765-43210'), true);
  assert.equal(looksLikePhone('asha@example.com'), false);
  assert.equal(looksLikePhone('1234'), false);
  assert.equal(formatPhone('+919876543210'), '+91 98765 43210');
});
