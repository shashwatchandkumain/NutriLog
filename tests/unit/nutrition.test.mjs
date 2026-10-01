import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bmr, tdee, calorieTarget, macroTargets, recommendTargets, proteinBasisWeight, suggestActivityLevel,
  scaleNutrition, sumNutrition, checkConsistency, isValidNutrition, macroCalories, goalPlan,
  kgToLb, lbToKg, cmToFtIn, ftInToCm, formatWeight, formatHeight, trimNumber,
} from '../../js/lib/nutrition.js';
import { addDays } from '../../js/lib/utils.js';

const close = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

test('BMR uses Mifflin–St Jeor', () => {
  // 10·80 + 6.25·180 − 5·30 + 5 = 1780
  assert.equal(bmr({ weightKg: 80, heightCm: 180, age: 30, sex: 'male' }), 1780);
  // 10·60 + 6.25·165 − 5·25 − 161 = 1345.25
  assert.equal(bmr({ weightKg: 60, heightCm: 165, age: 25, sex: 'female' }), 1345.25);
  // Unspecified sex uses the midpoint constant (−78)
  assert.equal(bmr({ weightKg: 80, heightCm: 180, age: 30 }), 1697);
  assert.equal(bmr({ weightKg: 0, heightCm: 180, age: 30 }), null);
});

test('TDEE applies the activity multiplier', () => {
  close(tdee(1780, 'sedentary'), 2136);
  close(tdee(1780, 'moderate'), 2759);
  close(tdee(1780, 'very_active'), 3382);
  close(tdee(1780, 'unknown'), 2136);
});

test('calorie targets by goal', () => {
  close(calorieTarget(2759, 'maintain', 'male'), 2759);
  close(calorieTarget(2759, 'lose', 'male'), 2259);          // −500
  close(calorieTarget(1440, 'lose', 'female'), 1200);        // −288 (20%) → 1152, floored at 1200
  close(calorieTarget(1300, 'lose', 'female'), 1200);        // −260 → 1040, floored at 1200
  close(calorieTarget(1100, 'lose', 'female'), 1100);        // floor never pushes above TDEE
  close(calorieTarget(2759, 'gain', 'male'), 3034.9);        // +10% (275.9)
  close(calorieTarget(2000, 'gain', 'male'), 2250);          // +10% clamped up to 250
  close(calorieTarget(2759, 'muscle', 'male'), 2909);        // +5% (138) clamped up to 150
});

test('macro targets add up to the calorie target', () => {
  const m = macroTargets({ calories: 2259, weightKg: 80, heightCm: 180, goal: 'lose' });
  close(m.protein, 144);                     // 1.8 g/kg × 80
  close(m.fat, (0.28 * 2259) / 9);
  close(macroCalories(m), 2259, 0.5);
  close(m.fiber, 31.626);                    // 14 g / 1000 kcal
  for (const style of ['balanced', 'high_protein', 'low_carb', 'keto']) {
    for (const goal of ['lose', 'maintain', 'gain', 'muscle']) {
      const t = macroTargets({ calories: 2100, weightKg: 70, heightCm: 170, goal, macroStyle: style });
      close(macroCalories(t), 2100, 0.5);
      assert.ok(t.protein * 4 <= 2100 * 0.4 + 1e-9);
      assert.ok(t.carbs >= 0 && t.fat >= 0);
    }
  }
  assert.equal(macroTargets({ calories: 2000, weightKg: 70, heightCm: 170, macroStyle: 'keto' }).carbs, 30);
});

test('protein uses an adjusted weight above BMI 25', () => {
  close(proteinBasisWeight(70, 175), 70);
  close(proteinBasisWeight(100, 170), 72.25 + 0.4 * 27.75); // ref 25·1.7² = 72.25
});

test('recommendTargets end to end and exercise mode (exact, not rounded to tens)', () => {
  const p = { weight_kg: 80, height_cm: 180, age: 30, sex: 'male', activity_level: 'moderate', goal: 'lose' };
  const r = recommendTargets(p);
  assert.deepEqual([r.bmr, r.tdee, r.calories, r.protein], [1780, 2759, 2259, 144]);
  assert.equal(r.plan, null, 'no target weight → no plan');
  close(macroCalories(r), 2259, 1);
  const add = recommendTargets(p, { exerciseMode: 'add' });
  close(add.tdee, 2136); // sedentary base, workouts added per day
  assert.equal(recommendTargets({ weight_kg: 80 }), null);
});

test('goal date: the daily deficit that reaches the target weight exactly on the date', () => {
  const today = '2026-10-01';
  const p = goalPlan({ weightKg: 92, targetKg: 85, targetDate: addDays(today, 100), today, tdee: 2800, goal: 'lose', sex: 'male' });
  assert.equal(p.status, 'dated');
  close(p.requiredDaily, -539);                   // −7 kg × 7,700 kcal ÷ 100 days
  close(p.calories, 2261);
  close(p.plannedWeeklyKg, -0.49);
  assert.equal(p.projectedDate, addDays(today, 100));

  // Too soon: capped at 1% of body weight per week.
  const fast = goalPlan({ weightKg: 92, targetKg: 85, targetDate: addDays(today, 30), today, tdee: 2800, goal: 'lose', sex: 'male' });
  assert.equal(fast.status, 'capped');
  close(fast.plannedDaily, -(0.92 * 7700) / 7);
  assert.equal(fast.projectedDate, addDays(today, 54));

  // Never below the safety floor.
  const floor = goalPlan({ weightKg: 70, targetKg: 60, targetDate: addDays(today, 60), today, tdee: 1700, goal: 'lose', sex: 'female' });
  assert.deepEqual([floor.status, floor.calories], ['capped', 1200]);

  // Gaining: up to 0.5 kg a week (0.25 kg for muscle).
  const gain = goalPlan({ weightKg: 60, targetKg: 65, targetDate: addDays(today, 70), today, tdee: 2200, goal: 'gain', sex: 'male' });
  assert.equal(gain.status, 'dated');
  close(gain.calories, 2750);
  assert.equal(goalPlan({ weightKg: 70, targetKg: 72, targetDate: addDays(today, 30), today, tdee: 2500, goal: 'muscle', sex: 'male' }).status, 'capped');

  // At or past the target → maintenance; past date → standard pace; maintain → no plan.
  const reached = goalPlan({ weightKg: 84.9, targetKg: 85, targetDate: addDays(today, 30), today, tdee: 2800, goal: 'lose', sex: 'male' });
  assert.deepEqual([reached.status, reached.calories], ['reached', 2800]);
  const past = goalPlan({ weightKg: 92, targetKg: 85, targetDate: today, today, tdee: 2800, goal: 'lose', sex: 'male' });
  assert.deepEqual([past.status, past.calories], ['past', 2300]);
  const def = goalPlan({ weightKg: 92, targetKg: 85, targetDate: null, today, tdee: 2800, goal: 'lose', sex: 'male' });
  assert.equal(def.status, 'default');
  assert.equal(def.projectedDate, addDays(today, Math.ceil((7 * 7700) / 500)));
  assert.equal(goalPlan({ weightKg: 92, targetKg: 85, targetDate: addDays(today, 30), today, tdee: 2800, goal: 'maintain' }), null);

  // recommendTargets uses the plan.
  const r = recommendTargets({ weight_kg: 92, height_cm: 175, age: 30, sex: 'male', activity_level: 'moderate', goal: 'lose',
    target_weight_kg: 85, target_date: addDays(today, 100) }, { today });
  close(r.tdee, 1868.75 * 1.55);
  assert.equal(r.calories, Math.round(1868.75 * 1.55 - 539));
  assert.equal(r.plan.status, 'dated');
});

test('activity level suggestion from steps and workouts', () => {
  assert.equal(suggestActivityLevel({}), 'sedentary');
  assert.equal(suggestActivityLevel({ dailySteps: 6000 }), 'light');
  assert.equal(suggestActivityLevel({ dailySteps: 11000 }), 'moderate');
  assert.equal(suggestActivityLevel({ dailySteps: 11000, workoutsPerWeek: 4 }), 'active');
  assert.equal(suggestActivityLevel({ workoutsPerWeek: 6 }), 'active');
  assert.equal(suggestActivityLevel({ dailySteps: 14000, workoutsPerWeek: 6 }), 'very_active');
});

test('portion scaling is linear from the base serving (spec example: 150 g of a 100 g base)', () => {
  const food = { servingSize: 100, calories: 165, protein: 31, carbs: 0, fat: 3.6, fiber: 0 };
  const n = scaleNutrition(food, 150);
  close(n.calories, 247.5); close(n.protein, 46.5); close(n.fat, 5.4);
  const roti = { servingSize: 100, calories: 280, protein: 9, carbs: 52.7, fat: 3.7, fiber: 8.4 };
  close(scaleNutrition(roti, 2 * 40).calories, 224); // 2 medium rotis
  assert.deepEqual(scaleNutrition(roti, 0), { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 });
  // Not rounded internally
  close(scaleNutrition({ servingSize: 100, calories: 33, protein: 0, carbs: 0, fat: 0, fiber: 0 }, 10).calories, 3.3, 1e-9);
});

test('totals are exact sums', () => {
  const t = sumNutrition([{ calories: 100.4, protein: 1.25 }, { calories: 50.4, protein: 2.25, fat: 1 }, { calories: '3', fiber: null }]);
  close(t.calories, 153.8, 1e-9); close(t.protein, 3.5, 1e-9); assert.equal(t.fat, 1); assert.equal(t.fiber, 0);
});

test('Atwater consistency check', () => {
  assert.equal(checkConsistency({ calories: 165, protein: 31, carbs: 0, fat: 3.6 }).ok, true);
  assert.equal(checkConsistency({ calories: 738, protein: 1.4, carbs: 8.2, fat: 77.6 }).ok, true); // consistent, just wrong
  assert.equal(checkConsistency({ calories: 27, protein: 12.9, carbs: 1.1, fat: 13.5 }).ok, false);
  assert.equal(checkConsistency({ calories: 30, protein: 3, carbs: 5.9, fat: 0.2 }).ok, true); // 7.5 kcal gap on a low-calorie food
});

test('nutrition validation', () => {
  assert.equal(isValidNutrition({ calories: 100, protein: 5, carbs: 10, fat: 2, fiber: 1 }, 100), true);
  assert.equal(isValidNutrition({ calories: -1, protein: 5, carbs: 10, fat: 2, fiber: 1 }), false);
  assert.equal(isValidNutrition({ calories: 1000, protein: 0, carbs: 0, fat: 0, fiber: 0 }, 100), false); // >9.5 kcal/g
  assert.equal(isValidNutrition({ calories: NaN, protein: 0, carbs: 0, fat: 0, fiber: 0 }), false);
});

test('unit conversions round-trip', () => {
  close(kgToLb(100), 220.462, 0.001);
  close(lbToKg(kgToLb(72.5)), 72.5, 1e-9);
  assert.deepEqual(cmToFtIn(180), { ft: 5, in: 11 });
  assert.deepEqual(cmToFtIn(182.8), { ft: 6, in: 0 });
  close(ftInToCm(5, 11), 180.34, 0.001);
  assert.equal(formatWeight(80, 'lb'), '176.37 lb');
  assert.equal(formatWeight(80, 'kg'), '80 kg');
  assert.equal(formatWeight(91.55, 'kg'), '91.55 kg');
  assert.equal(formatWeight(91.5, 'kg'), '91.5 kg');
  assert.equal(trimNumber(312.40, 1), '312.4');
  assert.equal(trimNumber(100, 1), '100');
  assert.equal(formatHeight(180, 'ftin'), '5′ 11″');
});
