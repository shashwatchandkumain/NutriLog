import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStreak, totalsByDate, averageOfLoggedDays, weightChange, goalProgress, dailyScore, movingAverage, weightTrend } from '../../js/lib/stats.js';
import { sumNutrition } from '../../js/lib/nutrition.js';
import { netActivityCalories, treadmillMet, weightOn, presetMet, ACTIVITY_PRESETS } from '../../js/lib/activity.js';

test('streak counts consecutive days and survives an unlogged today', () => {
  assert.deepEqual(computeStreak(['2026-09-27', '2026-09-28', '2026-09-29'], '2026-09-29'), { current: 3, best: 3, daysLogged: 3 });
  assert.equal(computeStreak(['2026-09-27', '2026-09-28'], '2026-09-29').current, 2); // today not logged yet
  assert.equal(computeStreak(['2026-09-26', '2026-09-27'], '2026-09-29').current, 0);
  assert.equal(computeStreak(['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-09-29'], '2026-09-29').best, 4);
  assert.equal(computeStreak(['2026-02-28', '2026-03-01'], '2026-03-01').current, 2); // month boundary
  assert.deepEqual(computeStreak([], '2026-09-29'), { current: 0, best: 0, daysLogged: 0 });
});

test('daily and weekly totals come from the same items', () => {
  const items = [
    { meal_date: '2026-09-28', calories: 400.5, protein: 20, carbs: 50, fat: 10, fiber: 5 },
    { meal_date: '2026-09-28', calories: 300.25, protein: 10, carbs: 40, fat: 8, fiber: 3 },
    { meal_date: '2026-09-29', calories: 1000, protein: 60, carbs: 100, fat: 30, fiber: 10 },
  ];
  const byDay = totalsByDate(items);
  assert.equal(byDay['2026-09-28'].calories, sumNutrition(items.slice(0, 2)).calories);
  assert.equal(byDay['2026-09-28'].count, 2);
  const week = Object.values(byDay).reduce((s, d) => s + d.calories, 0);
  assert.equal(week, sumNutrition(items).calories);
  const avg = averageOfLoggedDays(byDay, ['2026-09-27', '2026-09-28', '2026-09-29']);
  assert.equal(avg.days, 2); // unlogged days are not averaged in as zero
  assert.equal(avg.calories, (700.75 + 1000) / 2);
  assert.equal(averageOfLoggedDays(byDay, ['2026-01-01']), null);
});

test('weight change and goal progress', () => {
  const w = [{ recorded_on: '2026-09-01', weight_kg: 82 }, { recorded_on: '2026-09-20', weight_kg: 80.5 }, { recorded_on: '2026-09-29', weight_kg: 79.9 }];
  const c = weightChange(w, 7, '2026-09-29');
  assert.equal(c.from.recorded_on, '2026-09-20');
  assert.ok(Math.abs(c.change - -0.6) < 1e-9);
  assert.equal(weightChange(w.slice(0, 1), 7, '2026-09-29'), null);
  assert.equal(goalProgress(82, 79, 76), 0.5);
  assert.equal(goalProgress(70, 72, 75), 0.4);   // gaining toward a higher target
  assert.equal(goalProgress(82, 84, 76), 0);     // moved away → clamped
  assert.equal(goalProgress(80, 80, 80), null);
});

test('daily score', () => {
  const goals = { calories: 2000, protein: 100, fiber: 30 };
  assert.equal(dailyScore({ calories: 0 }, goals, 0), null);
  assert.equal(dailyScore({ calories: 1950, protein: 95, fiber: 28 }, goals, 4).score, 100);
  assert.ok(dailyScore({ calories: 500, protein: 10, fiber: 2 }, goals, 1).score < 30);
});

test('exercise uses net MET calories', () => {
  assert.equal(netActivityCalories(9.8, 80, 30), (9.8 - 1) * 80 * 0.5); // 352
  assert.equal(netActivityCalories(1, 80, 60), 0);
  assert.equal(netActivityCalories(5, 0, 60), 0);
});

test('treadmill MET from speed and incline (ACSM equations)', () => {
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);
  close(treadmillMet({ speedKmh: 6 }), 13.5 / 3.5);                       // walking 100 m/min, flat
  close(treadmillMet({ speedKmh: 5, inclinePct: 10 }), (3.5 + 0.1 * (5000 / 60) + 1.8 * (5000 / 60) * 0.1) / 3.5); // uphill walk
  close(treadmillMet({ speedKmh: 10, inclinePct: 1 }), (3.5 + 0.2 * (10000 / 60) + 0.9 * (10000 / 60) * 0.01) / 3.5); // running
  close(treadmillMet({ speedKmh: 6.5, mode: 'run' }), (3.5 + 0.2 * (6500 / 60)) / 3.5);
  assert.equal(treadmillMet({ speedKmh: 0 }), null);
  // 30 min at 6 km/h for a 92 kg person: (MET − 1) × 92 × 0.5
  close(netActivityCalories(treadmillMet({ speedKmh: 6 }), 92, 30), (13.5 / 3.5 - 1) * 46);
});

test('weight on a date follows the database rule', () => {
  const w = [{ recorded_on: '2026-09-20', weight_kg: 72.5 }, { recorded_on: '2026-09-24', weight_kg: 70.25 }];
  assert.equal(weightOn('2026-09-25', w), 70.25);
  assert.equal(weightOn('2026-09-22', w), 72.5);
  assert.equal(weightOn('2026-09-10', w), 72.5, 'before the first weigh-in → the earliest one');
  assert.equal(weightOn('2026-09-10', [], 80), 80);
  assert.equal(weightOn('2026-09-10', [], null), null);
});

test('weight trend needs 3+ weigh-ins over a week; moving average smooths daily noise', () => {
  const w = [
    { recorded_on: '2026-09-01', weight_kg: 80 }, { recorded_on: '2026-09-08', weight_kg: 79.5 },
    { recorded_on: '2026-09-15', weight_kg: 79 }, { recorded_on: '2026-09-22', weight_kg: 78.5 },
  ];
  assert.ok(Math.abs(weightTrend(w, '2026-09-01', '2026-09-30') - -0.5) < 1e-9, '−0.5 kg a week');
  assert.equal(weightTrend(w.slice(0, 2), '2026-09-01', '2026-09-30'), null, 'two points are not a trend');
  assert.equal(weightTrend([{ recorded_on: '2026-09-01', weight_kg: 80 }, { recorded_on: '2026-09-02', weight_kg: 81 }, { recorded_on: '2026-09-03', weight_kg: 79 }], '2026-09-01', '2026-09-30'), null, 'under a week');
  const daily = [{ recorded_on: '2026-09-01', weight_kg: 80 }, { recorded_on: '2026-09-02', weight_kg: 81 }, { recorded_on: '2026-09-09', weight_kg: 79 }];
  assert.deepEqual(movingAverage(daily).map((x) => x.value), [80, 80.5, 79]);
});

test('activity intensities use Compendium METs; moderate is the preset default', () => {
  const walk = ACTIVITY_PRESETS.find((a) => a.id === 'walking');
  assert.deepEqual([presetMet(walk, 'light'), presetMet(walk), presetMet(walk, 'vigorous')], [2.8, 3.5, 4.3]);
  const hiit = ACTIVITY_PRESETS.find((a) => a.id === 'hiit');
  assert.equal(presetMet(hiit, 'vigorous'), 8, 'presets without intensities keep their MET');
  for (const p of ACTIVITY_PRESETS) if (p.intensities?.moderate) assert.equal(p.intensities.moderate, p.met, p.id);
});
