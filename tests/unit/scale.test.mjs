import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScaleFrame, WeighInSession } from '../../js/lib/scale-protocol.js';
import { bmi, bmiClass, bodyFatPct, totalBodyWater, bodyComposition } from '../../js/lib/body-composition.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

/** Builds an 11-byte Cult frame with a valid XOR checksum. */
function frame(kg, { hr = 0, settling = false, badChecksum = false } = {}) {
  const raw = Math.round(kg * 100);
  const b = new Uint8Array([0xcf, hr, 0xc0, raw & 0xff, raw >> 8, 0x12, 0x34, 0x56, 0, settling ? 1 : 0, 0]);
  for (let i = 0; i < 10; i++) b[10] ^= b[i];
  if (badChecksum) b[10] ^= 0xff;
  return b;
}

test('parses captured Cult scale frames', () => {
  // Captured reference frames (see the protocol notes): 75.0 kg settling, and 75.0 kg with HR 60.
  const weigh = parseScaleFrame(new Uint8Array([0xcf, 0x00, 0x00, 0x4c, 0x1d, 0x00, 0x00, 0x00, 0x00, 0x01, 0x9f]));
  assert.deepEqual(weigh, { checksumOk: true, weightKg: 75, heartRate: null, settling: true });
  const body = parseScaleFrame(new Uint8Array([0xcf, 0x3c, 0xc0, 0x4c, 0x1d, 0xf4, 0x01, 0x00, 0x00, 0x00, 0x97]));
  assert.deepEqual(body, { checksumOk: true, weightKg: 75, heartRate: 60, settling: false });
  assert.equal(parseScaleFrame(frame(91.55)).weightKg, 91.55, 'keeps 0.01 kg precision');
  assert.equal(parseScaleFrame(frame(80, { badChecksum: true })).checksumOk, false);
  assert.equal(parseScaleFrame(new Uint8Array([1, 2, 3])), null);
  assert.equal(parseScaleFrame(new Uint8Array(11)), null, 'wrong marker');
  // DataView input (what Web Bluetooth delivers)
  const f = frame(70.2);
  assert.equal(parseScaleFrame(new DataView(f.buffer)).weightKg, 70.2);
});

test('weigh-in locks the settled weight, then waits for a converged heart rate', () => {
  const s = new WeighInSession();
  const types = (frames) => frames.flatMap((f) => s.feed(f)).filter((e) => e.type !== 'live').map((e) => e.type);
  assert.deepEqual(types([frame(0), frame(45.3, { settling: true }), frame(91.5, { settling: true }), frame(91.55, { settling: true }), frame(91.55, { settling: true })]), []);
  const events = s.feed(frame(91.55, { settling: true }));
  assert.deepEqual(events.find((e) => e.type === 'locked'), { type: 'locked', weightKg: 91.55 });
  assert.equal(s.locked, true);
  // Heart rate must repeat to count; out-of-range readings are ignored.
  assert.deepEqual(types([frame(91.55, { hr: 250 }), frame(91.55, { hr: 71 }), frame(91.55, { hr: 72 }), frame(91.55, { hr: 72 })]), ['heart', 'heart', 'heart']);
  const done = s.feed(frame(91.55, { hr: 72 }));
  assert.deepEqual(done.at(-1), { type: 'complete', weightKg: 91.55, heartRate: 72, reason: 'heart-rate' });
  assert.deepEqual(s.feed(frame(91.55, { hr: 72 })), [], 'nothing after completion');
  assert.equal(s.finish('idle'), null, 'completes only once');
});

test('weigh-in ends with the stable weight when the user steps off or frames stop', () => {
  const s = new WeighInSession();
  for (const kg of [91.5, 91.5, 91.5, 91.6, 91.6]) s.feed(frame(kg));
  // 91.6 only repeated twice, so the stable weight is still 91.5; a passing value never wins.
  const off = s.feed(frame(40.2)).concat(s.feed(frame(0)));
  assert.deepEqual(off.find((e) => e.type === 'complete'), { type: 'complete', weightKg: 91.5, heartRate: null, reason: 'stepped-off' });

  const t = new WeighInSession();
  for (let i = 0; i < 3; i++) t.feed(frame(68.4));
  t.feed(frame(68.4, { badChecksum: true }));
  assert.deepEqual(t.finish('idle'), { type: 'complete', weightKg: 68.4, heartRate: null, reason: 'idle' });

  const never = new WeighInSession();
  never.feed(frame(70)); never.feed(frame(71));
  assert.equal(never.finish('timeout'), null, 'no reading without a locked weight');
});

test('body composition equations (Deurenberg, Watson, Mifflin–St Jeor)', () => {
  close(bmi(100, 200), 25);
  assert.equal(bmiClass(24.9), 'Normal');
  assert.equal(bmiClass(29.9), 'Overweight');
  close(bodyFatPct(25, 40, 'male'), 23.0);          // 30 + 9.2 − 10.8 − 5.4
  close(bodyFatPct(25, 40, 'female'), 33.8);
  close(bodyFatPct(25, 40, null), 28.4, 1e-9);      // midpoint when sex is not given
  close(bodyFatPct(20, 14, 'female'), 1.51 * 20 - 0.7 * 14 + 1.4); // child equation
  close(totalBodyWater(80, 180, 30, 'male'), 2.447 - 0.09156 * 30 + 0.1074 * 180 + 0.3362 * 80);
  close(totalBodyWater(60, 165, 25, 'female'), -2.097 + 0.1069 * 165 + 0.2466 * 60);

  const c = bodyComposition({ weightKg: 91.55, heightCm: 175, age: 30, sex: 'male' });
  close(c.bmi, 29.8938775510);
  close(c.bodyFatPct, 1.2 * c.bmi + 6.9 - 16.2);
  close(c.fatMassKg + c.leanMassKg, 91.55);
  close(c.bodyWaterL, 49.27431);
  close(c.bodyWaterPct, (49.27431 / 91.55) * 100);
  close(c.bmrKcal, 1864.25);                        // 915.5 + 1093.75 − 150 + 5
  const partial = bodyComposition({ weightKg: 70 });
  assert.equal(partial.bmi, null);
  assert.equal(partial.bodyFatPct, null);
  assert.equal(partial.bmrKcal, null);
});
