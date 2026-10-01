import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectFormat, scaleProfiles, scaleWeighIns, scaleProfilePatch,
  nutrilogSummary, nutrilogProfilePatch, nutrilogGoals, nutrilogWeighIns, nutrilogItems, nutrilogActivities, nutrilogWater,
} from '../../js/lib/import-formats.js';
import { isoDate, uuidFrom } from '../../js/lib/utils.js';

const SCALE_BACKUP = {
  version: 1,
  exportedAt: '2026-09-30T10:00:00.000Z',
  profiles: [
    { id: 1, name: 'Shashwat', sex: 'male', birthYear: 1996, heightCm: 175, color: '#5b8cff' },
    { id: 2, name: '<b>Asha</b>', sex: 'female', birthYear: 1999, heightCm: 160 },
  ],
  readings: [
    { id: 1, profileId: 1, ts: '2026-09-28T12:00:00.000Z', weightKg: 92.1, heartRate: 70, source: 'scale' },
    { id: 2, profileId: 1, ts: '2026-09-28T12:30:00.000Z', weightKg: 91.95, heartRate: null, source: 'scale' },
    { id: 3, profileId: 1, ts: '2026-09-25T12:00:00.000Z', weightKg: 92.6, heartRate: 400, source: 'manual' },
    { id: 4, profileId: 1, ts: 'not a date', weightKg: 90 },
    { id: 5, profileId: 1, ts: '2026-09-20T12:00:00.000Z', weightKg: 5 },
    { id: 6, profileId: 2, ts: '2026-09-28T12:00:00.000Z', weightKg: 58.2 },
  ],
  settings: [],
};

test('detects backup formats', () => {
  assert.equal(detectFormat(SCALE_BACKUP), 'scale');
  assert.equal(detectFormat({ app: 'NutriLog', meal_items: [] }), 'nutrilog');
  assert.equal(detectFormat({ app: 'Other' }), null);
  assert.equal(detectFormat(null), null);
  assert.equal(detectFormat([1, 2]), null);
});

test('smart-scale backup: profiles and one weigh-in per day', () => {
  const profiles = scaleProfiles(SCALE_BACKUP, new Date('2026-10-01T00:00:00Z'));
  assert.deepEqual(profiles[0], { id: 1, name: 'Shashwat', sex: 'male', age: 30, heightCm: 175, readings: 5 });
  assert.equal(profiles[1].name, '<b>Asha</b>', 'names are kept as text (escaped when shown)');
  const w = scaleWeighIns(SCALE_BACKUP, 1);
  assert.equal(w.length, 2, 'invalid timestamps and impossible weights are skipped');
  assert.deepEqual(w.map((x) => x.kg), [92.6, 91.95]);
  assert.equal(w[1].date, isoDate(new Date('2026-09-28T12:30:00.000Z')), 'the latest reading of the day wins');
  assert.equal(w[1].measuredAt, '2026-09-28T12:30:00.000Z');
  assert.equal(w[0].heartRate, null, 'implausible heart rate dropped');
  assert.deepEqual(scaleProfilePatch(profiles[0]), { sex: 'male', age: 30, height_cm: 175 });
  assert.deepEqual(scaleWeighIns(SCALE_BACKUP, 99), []);
});

const EXPORT = {
  app: 'NutriLog',
  exported_at: '2026-09-30T10:00:00Z',
  account: { id: 'x', email: 'friend@example.com' },
  profile: { display_name: 'Friend', age: 28, sex: 'female', height_cm: 162.5, target_weight_kg: 58, target_date: '2026-12-31',
    goal: 'lose', activity_level: 'light', diet_type: 'vegetarian', macro_style: 'nonsense', allergies: ['Peanuts', ''], daily_steps: 6000.4 },
  daily_goals: { calories: 1650, protein_g: 95.5, carbs_g: 180, fat_g: 50, fiber_g: 25, is_custom: true },
  weight_history: [
    { recorded_on: '2026-09-01', weight_kg: 63.4, bmi: 24.01, body_fat_pct: 33.2, heart_rate_bpm: 68 },
    { recorded_on: '2026-09-15', weight_kg: 62.85 },
    { recorded_on: 'bad', weight_kg: 60 },
  ],
  meal_items: [
    { id: 'i1', meal_date: '2026-09-01', meal_type: 'lunch', food_name: 'Dal', source: 'ai_text', quantity: 150, unit: 'g', grams: 150, calories: 156.5, protein: 9, carbs: 24, fat: 2.7, fiber: 6 },
    { id: 'i2', meal_date: '2026-09-01', meal_type: 'brunch', food_name: 'Poha', source: 'whatever', quantity: 1, unit: 'plate', calories: 300, protein: 6, carbs: 50, fat: 8, fiber: 3 },
    { id: 'i3', meal_date: '2026-09-01', meal_type: 'lunch', food_name: '', calories: 10 },
    { id: 'i4', meal_date: '2026-09-01', meal_type: 'lunch', food_name: 'Bad', calories: -5 },
  ],
  activities: [{ id: 'a1', activity_date: '2026-09-01', name: 'Treadmill', duration_min: 30, met: 3.86, calories_burned: 131.43, source: 'preset' }],
  water_logs: [{ log_date: '2026-09-01', glasses: 6 }, { log_date: '2026-09-02', glasses: 99 }],
};

test('NutriLog export: summary, profile, goals and weigh-ins are validated', () => {
  assert.deepEqual(nutrilogSummary(EXPORT), { name: 'Friend', email: 'friend@example.com', exportedAt: '2026-09-30T10:00:00Z', weights: 3, items: 4, activities: 1, water: 2, hasProfile: true, hasGoals: true });
  const p = nutrilogProfilePatch(EXPORT);
  assert.equal(p.macro_style, 'balanced', 'unknown values fall back to defaults');
  assert.deepEqual(p.allergies, ['Peanuts']);
  assert.equal(p.daily_steps, 6000);
  assert.equal(p.target_date, '2026-12-31');
  assert.deepEqual(nutrilogGoals(EXPORT), { calories: 1650, protein: 95.5, carbs: 180, fat: 50, fiber: 25, isCustom: true });
  const w = nutrilogWeighIns(EXPORT);
  assert.equal(w.length, 2);
  assert.equal(w[0].composition.body_fat_pct, 33.2);
  assert.equal(w[0].heartRate, 68);
  assert.equal(w[1].composition, null, 'older exports have no snapshot');
  assert.deepEqual(nutrilogWater(EXPORT), [{ log_date: '2026-09-01', glasses: 6 }]);
});

test('NutriLog export: rows get deterministic ids per importing user', async () => {
  const a = await nutrilogItems(EXPORT, 'user-a');
  assert.equal(a.length, 2, 'rows without a name or with negative calories are skipped');
  assert.deepEqual([a[1].meal_type, a[1].source], ['snack', 'manual']);
  const again = await nutrilogItems(EXPORT, 'user-a');
  assert.deepEqual(a.map((x) => x.id), again.map((x) => x.id), 'same file + same user → same ids (re-import is a no-op)');
  const b = await nutrilogItems(EXPORT, 'user-b');
  assert.notEqual(a[0].id, b[0].id, 'another user importing the same file gets different ids');
  assert.match(a[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const acts = await nutrilogActivities(EXPORT, 'user-a');
  assert.deepEqual([acts[0].met, acts[0].duration_min], [3.86, 30]);
  assert.equal(acts[0].id, await uuidFrom('user-a:activity:a1'));
});
