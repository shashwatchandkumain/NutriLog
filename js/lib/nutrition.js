// Pure nutrition math: energy targets, macro targets, portion scaling, totals.
// No DOM, no network — unit-tested in tests/nutrition.test.mjs.

export const KCAL_PER_GRAM = { protein: 4, carbs: 4, fat: 9 };
export const NUTRIENTS = ['calories', 'protein', 'carbs', 'fat', 'fiber'];

// Standard activity multipliers applied to BMR (they include typical exercise).
export const ACTIVITY_LEVELS = {
  sedentary:   { multiplier: 1.2,   label: 'Sedentary',         description: 'Desk job, under ~5,000 steps, little or no exercise' },
  light:       { multiplier: 1.375, label: 'Lightly active',    description: '5,000–7,500 steps or exercise 1–3 days a week' },
  moderate:    { multiplier: 1.55,  label: 'Moderately active', description: '7,500–10,000 steps or exercise 3–5 days a week' },
  active:      { multiplier: 1.725, label: 'Very active',       description: 'Over 10,000 steps or hard exercise 6–7 days a week' },
  very_active: { multiplier: 1.9,   label: 'Extremely active',  description: 'Physical job plus hard daily training' },
};

export const GOALS = {
  lose:     { label: 'Lose weight',     proteinPerKg: 1.8 },
  maintain: { label: 'Maintain weight', proteinPerKg: 1.4 },
  gain:     { label: 'Gain weight',     proteinPerKg: 1.6 },
  muscle:   { label: 'Build muscle',    proteinPerKg: 2.0 },
};

export const MACRO_STYLES = {
  balanced:     { label: 'Balanced',     fatShare: 0.28 },
  high_protein: { label: 'High protein', fatShare: 0.25, extraProteinPerKg: 0.4 },
  low_carb:     { label: 'Low carb',     fatShare: 0.40 },
  keto:         { label: 'Keto',         carbsGrams: 30 },
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const round1 = (v) => Math.round((Number(v) || 0) * 10) / 10;

/**
 * Basal metabolic rate, Mifflin–St Jeor (1990): the most accurate of the common
 * predictive equations for healthy adults.
 *   men:   10·kg + 6.25·cm − 5·age + 5
 *   women: 10·kg + 6.25·cm − 5·age − 161
 * If sex is not given, the midpoint of the two constants (−78) is used.
 */
export function bmr({ weightKg, heightCm, age, sex }) {
  if (!(weightKg > 0 && heightCm > 0 && age > 0)) return null;
  const s = sex === 'male' ? 5 : sex === 'female' ? -161 : -78;
  return 10 * weightKg + 6.25 * heightCm - 5 * age + s;
}

/** Total daily energy expenditure = BMR × activity multiplier. */
export function tdee(bmrValue, activityLevel) {
  if (!(bmrValue > 0)) return null;
  const level = ACTIVITY_LEVELS[activityLevel] || ACTIVITY_LEVELS.sedentary;
  return bmrValue * level.multiplier;
}

/** Suggests an activity level from optional daily steps and workouts per week. */
export function suggestActivityLevel({ dailySteps, workoutsPerWeek } = {}) {
  const steps = Number(dailySteps) || 0;
  const workouts = Number(workoutsPerWeek) || 0;
  const stepScore = steps >= 12500 ? 3 : steps >= 10000 ? 2.5 : steps >= 7500 ? 2 : steps >= 5000 ? 1 : 0;
  const workoutScore = workouts >= 6 ? 3 : workouts >= 3 ? 2 : workouts >= 1 ? 1 : 0;
  const score = Math.max(stepScore, workoutScore) + (stepScore >= 2 && workoutScore >= 2 ? 0.5 : 0);
  if (score >= 3.5) return 'very_active';
  if (score >= 3) return 'active';
  if (score >= 2) return 'moderate';
  if (score >= 1) return 'light';
  return 'sedentary';
}

/** Minimum daily intake we will recommend without medical supervision. */
export function calorieFloor(sex) {
  return sex === 'male' ? 1500 : sex === 'female' ? 1200 : 1350;
}

/**
 * Daily calorie target from TDEE and goal.
 *   lose:     TDEE − min(500, 20% of TDEE)   (≈0.45 kg/week), never below the safety floor
 *   maintain: TDEE
 *   gain:     TDEE + 10% of TDEE, clamped to 250–500 kcal
 *   muscle:   TDEE + 5% of TDEE, clamped to 150–300 kcal (lean gain)
 */
export function calorieTarget(tdeeValue, goal, sex) {
  if (!(tdeeValue > 0)) return null;
  switch (goal) {
    case 'lose': {
      const target = tdeeValue - Math.min(500, 0.2 * tdeeValue);
      return Math.min(tdeeValue, Math.max(target, calorieFloor(sex)));
    }
    case 'gain': return tdeeValue + clamp(0.10 * tdeeValue, 250, 500);
    case 'muscle': return tdeeValue + clamp(0.05 * tdeeValue, 150, 300);
    default: return tdeeValue;
  }
}

/**
 * Body weight used for protein targets. Above BMI 25 an adjusted weight is used
 * (reference weight at BMI 25 + 40% of the excess) so targets stay sensible for larger bodies.
 */
export function proteinBasisWeight(weightKg, heightCm) {
  if (!(heightCm > 0)) return weightKg;
  const ref = 25 * (heightCm / 100) ** 2;
  return weightKg > ref ? ref + 0.4 * (weightKg - ref) : weightKg;
}

/**
 * Macro targets (grams) for a calorie target.
 *   protein: g/kg by goal (+0.4 for high-protein), capped at 35% of calories (40% high-protein)
 *   fat:     share of calories by style (keto: remainder after protein and carbs)
 *   carbs:   remainder of calories (keto: fixed 30 g)
 *   fiber:   14 g per 1000 kcal (IOM adequate intake), 20–45 g
 */
export function macroTargets({ calories, weightKg, heightCm, goal = 'maintain', macroStyle = 'balanced' }) {
  if (!(calories > 0)) return null;
  const style = MACRO_STYLES[macroStyle] || MACRO_STYLES.balanced;
  const perKg = (GOALS[goal] || GOALS.maintain).proteinPerKg + (style.extraProteinPerKg || 0);
  const basis = weightKg > 0 ? proteinBasisWeight(weightKg, heightCm) : 70;
  const proteinCap = (macroStyle === 'high_protein' ? 0.40 : 0.35) * calories / KCAL_PER_GRAM.protein;
  const protein = Math.min(perKg * basis, proteinCap);

  let fat, carbs;
  if (macroStyle === 'keto') {
    carbs = style.carbsGrams;
    fat = Math.max(0, (calories - protein * 4 - carbs * 4) / 9);
  } else {
    fat = (style.fatShare * calories) / 9;
    carbs = Math.max(0, (calories - protein * 4 - fat * 9) / 4);
  }
  const fiber = clamp(14 * calories / 1000, 20, 45);
  return { protein, carbs, fat, fiber };
}

/**
 * Full recommendation from a profile (kg/cm units), rounded for display, or null if the
 * profile is incomplete. exerciseMode 'add' bases the target on a sedentary TDEE because
 * logged workouts are then added to each day's budget.
 */
export function recommendTargets(profile, { exerciseMode = 'included' } = {}) {
  const { weight_kg: weightKg, height_cm: heightCm, age, sex, activity_level: activityLevel, goal, macro_style: macroStyle } = profile || {};
  const b = bmr({ weightKg: Number(weightKg), heightCm: Number(heightCm), age: Number(age), sex });
  if (!b) return null;
  // In "add logged exercise" mode the base target is sedentary; workouts are added per day.
  const t = tdee(b, exerciseMode === 'add' ? 'sedentary' : activityLevel);
  const cal = calorieTarget(t, goal, sex);
  const m = macroTargets({ calories: cal, weightKg: Number(weightKg), heightCm: Number(heightCm), goal, macroStyle });
  return {
    bmr: Math.round(b),
    tdee: Math.round(t),
    calories: Math.round(cal / 10) * 10,
    protein: Math.round(m.protein),
    carbs: Math.round(m.carbs),
    fat: Math.round(m.fat),
    fiber: Math.round(m.fiber),
  };
}

/** Calories implied by macro targets — used to show whether custom targets add up. */
export function macroCalories({ protein = 0, carbs = 0, fat = 0 }) {
  return protein * KCAL_PER_GRAM.protein + carbs * KCAL_PER_GRAM.carbs + fat * KCAL_PER_GRAM.fat;
}

// ── Portions and totals ────────────────────────────────────────────────────

/**
 * Nutrition for `grams` of a food whose values are given per `servingSize` units.
 * Always linear: value × grams / servingSize. Results are NOT rounded.
 */
export function scaleNutrition(food, grams) {
  const g = Number(grams);
  const base = Number(food.servingSize) || 100;
  const factor = g > 0 ? g / base : 0;
  const out = {};
  for (const k of NUTRIENTS) out[k] = (Number(food[k]) || 0) * factor;
  return out;
}

/** Sum of nutrients over items (each item has calories/protein/carbs/fat/fiber). */
export function sumNutrition(items) {
  const t = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };
  for (const it of items || []) for (const k of NUTRIENTS) t[k] += Number(it[k]) || 0;
  return t;
}

/**
 * Consistency check: calories vs protein·4 + carbs·4 + fat·9.
 * Tolerance is 20% or 15 kcal, whichever is larger (label rounding, fiber and
 * alcohol all cause honest differences). Returns { ok, macroKcal, difference }.
 */
export function checkConsistency(n) {
  const macroKcal = macroCalories(n);
  const cal = Number(n.calories) || 0;
  const difference = macroKcal - cal;
  const tolerance = Math.max(15, 0.2 * Math.max(cal, macroKcal));
  return { ok: Math.abs(difference) <= tolerance, macroKcal, difference };
}

/** Validates a nutrition object: finite, non-negative numbers, plausible density. */
export function isValidNutrition(n, grams) {
  for (const k of NUTRIENTS) {
    const v = Number(n[k]);
    if (!Number.isFinite(v) || v < 0) return false;
  }
  if (grams > 0) {
    // No food exceeds ~9.1 kcal/g, and macros can't weigh more than the food.
    if (n.calories / grams > 9.5) return false;
    if ((n.protein + n.carbs + n.fat) / grams > 1.05) return false;
  }
  return true;
}

// ── Units ─────────────────────────────────────────────────────────────────
export const KG_PER_LB = 0.45359237;
export const CM_PER_IN = 2.54;
export const kgToLb = (kg) => kg / KG_PER_LB;
export const lbToKg = (lb) => lb * KG_PER_LB;
export function cmToFtIn(cm) {
  const totalIn = cm / CM_PER_IN;
  let ft = Math.floor(totalIn / 12);
  let inch = Math.round(totalIn - ft * 12);
  if (inch === 12) { ft += 1; inch = 0; }
  return { ft, in: inch };
}
export const ftInToCm = (ft, inch) => ((Number(ft) || 0) * 12 + (Number(inch) || 0)) * CM_PER_IN;

export function formatWeight(kg, unit, digits = 1) {
  if (kg == null || !Number.isFinite(Number(kg))) return '—';
  const v = unit === 'lb' ? kgToLb(Number(kg)) : Number(kg);
  return `${v.toFixed(digits).replace(/\.0$/, '')} ${unit === 'lb' ? 'lb' : 'kg'}`;
}
export function formatHeight(cm, unit) {
  if (!(cm > 0)) return '—';
  if (unit === 'ftin') { const { ft, in: i } = cmToFtIn(cm); return `${ft}′ ${i}″`; }
  return `${Math.round(cm)} cm`;
}
