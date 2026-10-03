// Weekly AI report and AI meal plans. All numbers are calculated here from the user's own logs
// (or, for meal plans, from the macros the model gives per item) — the model writes the advice
// and picks the foods, never the arithmetic.
import { energyFromMacros } from './nutrition.ts';

const r1 = (v: number) => Math.round(v * 10) / 10;
const r0 = (v: number) => Math.round(v);

// ── Weekly report ─────────────────────────────────────────────────────────
export interface WeekInput {
  start: string; end: string;                                   // YYYY-MM-DD, 7 days inclusive
  items: { meal_date: string; calories: number; protein: number; carbs: number; fat: number; fiber: number }[];
  goals: { calories: number; protein_g: number; carbs_g?: number; fat_g?: number; fiber_g?: number } | null;
  weights: { recorded_on: string; weight_kg: number }[];         // ascending, about the last 4 weeks
  activities: { activity_date: string; duration_min: number; calories_burned: number }[];
  water: { log_date: string; ml: number }[];
  waterGoalMl: number;
}

export interface WeekStats {
  start: string; end: string; days_logged: number;
  avg_calories: number | null; target_calories: number | null; calorie_days_on_target: number;
  avg_protein: number | null; target_protein: number | null; protein_days_hit: number;
  avg_carbs: number | null; avg_fat: number | null; avg_fiber: number | null;
  weight_start: number | null; weight_end: number | null; weight_change: number | null;
  active_days: number; activity_minutes: number; activity_kcal: number;
  avg_water_ml: number | null; water_goal_ml: number;
}

export function weeklyStats(w: WeekInput): WeekStats {
  const byDay = new Map<string, { calories: number; protein: number; carbs: number; fat: number; fiber: number }>();
  for (const it of w.items) {
    if (it.meal_date < w.start || it.meal_date > w.end) continue;
    const d = byDay.get(it.meal_date) ?? { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };
    for (const k of ['calories', 'protein', 'carbs', 'fat', 'fiber'] as const) d[k] += Number(it[k]) || 0;
    byDay.set(it.meal_date, d);
  }
  const days = [...byDay.values()];
  const avg = (k: 'calories' | 'protein' | 'carbs' | 'fat' | 'fiber') => (days.length ? days.reduce((s, d) => s + d[k], 0) / days.length : null);
  const tc = Number(w.goals?.calories) || null;
  const tp = Number(w.goals?.protein_g) || null;
  const inWeek = w.weights.filter((x) => x.recorded_on <= w.end);
  const before = inWeek.filter((x) => x.recorded_on < w.start).slice(-1)[0];
  const during = inWeek.filter((x) => x.recorded_on >= w.start);
  const first = before ?? during[0];
  const last = during[during.length - 1];
  const acts = w.activities.filter((a) => a.activity_date >= w.start && a.activity_date <= w.end);
  const water = w.water.filter((x) => x.log_date >= w.start && x.log_date <= w.end && x.ml > 0);
  return {
    start: w.start, end: w.end, days_logged: days.length,
    avg_calories: avg('calories') == null ? null : r0(avg('calories')!), target_calories: tc,
    calorie_days_on_target: tc ? days.filter((d) => Math.abs(d.calories - tc) <= tc * 0.1).length : 0,
    avg_protein: avg('protein') == null ? null : r1(avg('protein')!), target_protein: tp,
    protein_days_hit: tp ? days.filter((d) => d.protein >= tp * 0.9).length : 0,
    avg_carbs: avg('carbs') == null ? null : r1(avg('carbs')!), avg_fat: avg('fat') == null ? null : r1(avg('fat')!), avg_fiber: avg('fiber') == null ? null : r1(avg('fiber')!),
    weight_start: first ? Number(first.weight_kg) : null, weight_end: last ? Number(last.weight_kg) : null,
    weight_change: first && last && first !== last ? r1(Number(last.weight_kg) - Number(first.weight_kg)) : null,
    active_days: new Set(acts.map((a) => a.activity_date)).size,
    activity_minutes: acts.reduce((s, a) => s + (Number(a.duration_min) || 0), 0),
    activity_kcal: r0(acts.reduce((s, a) => s + (Number(a.calories_burned) || 0), 0)),
    avg_water_ml: water.length ? r0(water.reduce((s, x) => s + Number(x.ml), 0) / water.length) : null,
    water_goal_ml: w.waterGoalMl,
  };
}

export const REPORT_SYSTEM = `You are Nutri AI, a practical nutrition coach. Write a short weekly report from the numbers given (they are exact — never recompute or invent numbers, and never mention data that isn't given). Be specific, kind and honest; no medical advice. Respect the user's diet and allergies. Reply in English.
- headline: one sentence summing up the week.
- wins: 1-3 things that went well, each tied to a number.
- changes: the 2-3 most useful changes for next week, each with a concrete, doable action (foods, portions, timing).
- focus: one simple goal for next week.
If fewer than 3 days were logged, say the picture is incomplete and make logging the first change.`;

export const REPORT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['headline', 'wins', 'changes', 'focus'],
  properties: {
    headline: { type: 'string' },
    wins: { type: 'array', items: { type: 'string' } },
    changes: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'detail'], properties: { title: { type: 'string' }, detail: { type: 'string' } } } },
    focus: { type: 'string' },
  },
};

const txt = (v: unknown, n: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
export function normalizeReport(raw: unknown) {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    headline: txt(r.headline, 200) || 'Your week in review',
    wins: (Array.isArray(r.wins) ? r.wins : []).slice(0, 3).map((x) => txt(x, 300)).filter(Boolean),
    changes: (Array.isArray(r.changes) ? r.changes : []).slice(0, 3)
      .map((c) => ({ title: txt((c as Record<string, unknown>)?.title, 100), detail: txt((c as Record<string, unknown>)?.detail, 400) })).filter((c) => c.title),
    focus: txt(r.focus, 200),
  };
}

// ── Meal plan ─────────────────────────────────────────────────────────────
export const MEAL_TYPES = ['breakfast', 'lunch', 'snack', 'dinner'] as const;

export const PLAN_SYSTEM = `You plan practical, home-style meals (Indian-first unless the user's foods suggest otherwise) that fit the user's daily calorie and protein targets, diet type and allergies. Reply in English.
- Each day: breakfast, lunch, snack and dinner. Use common foods and realistic household portions (katori, roti, glass, grams). Vary the days; reuse ingredients to keep shopping simple.
- For every item give its portion, its weight in grams (ml for drinks) and the protein, carbs, fat and fiber of THAT portion. Calories are computed from them, so be accurate.
- Each day's total should be within about 5% of the calorie target and reach the protein target.
- Never include anything the user is allergic to; respect vegetarian/vegan/eggetarian diets strictly.
- grocery: everything needed for the whole plan, combined, with total quantities, grouped by category (vegetables, fruit, grains, dairy, protein, pantry).`;

export const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['days', 'grocery', 'notes'],
  properties: {
    days: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['day', 'meals'], properties: {
      day: { type: 'integer' },
      meals: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['meal_type', 'items'], properties: {
        meal_type: { type: 'string', enum: [...MEAL_TYPES] },
        items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['food_name', 'portion', 'grams', 'protein', 'carbs', 'fat', 'fiber'], properties: {
          food_name: { type: 'string' }, portion: { type: 'string' }, grams: { type: 'number' },
          protein: { type: 'number' }, carbs: { type: 'number' }, fat: { type: 'number' }, fiber: { type: 'number' } } } } } } } } } },
    grocery: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['item', 'quantity', 'category'], properties: {
      item: { type: 'string' }, quantity: { type: 'string' }, category: { type: 'string' } } } },
    notes: { type: 'string' },
  },
};

const n = (v: unknown, hi: number) => { const x = Number(v); return Number.isFinite(x) && x >= 0 ? Math.min(x, hi) : null; };

/** Validates a plan: possible portions only, calories from macros, totals per day and meal. */
export function normalizePlan(raw: unknown, days: number) {
  const r = (raw ?? {}) as Record<string, unknown>;
  const outDays = (Array.isArray(r.days) ? r.days : []).slice(0, days).map((d, di) => {
    const meals = (Array.isArray((d as Record<string, unknown>)?.meals) ? (d as Record<string, unknown>).meals as unknown[] : [])
      .filter((m) => MEAL_TYPES.includes((m as Record<string, unknown>)?.meal_type as typeof MEAL_TYPES[number]))
      .map((m) => {
        const items = (Array.isArray((m as Record<string, unknown>).items) ? (m as Record<string, unknown>).items as Record<string, unknown>[] : []).slice(0, 8).map((it) => {
          const grams = n(it.grams, 3000), p = n(it.protein, 300), c = n(it.carbs, 600), f = n(it.fat, 300), fib = n(it.fiber, 100);
          if (!txt(it.food_name, 80) || !grams || p == null || c == null || f == null || p + c + f > grams * 1.005) return null;
          return { food_name: txt(it.food_name, 80), portion: txt(it.portion, 60) || `${r0(grams)} g`, grams: r1(grams),
            protein: r1(p), carbs: r1(c), fat: r1(f), fiber: r1(Math.min(fib ?? 0, c)), calories: r0(energyFromMacros(p, c, f)) };
        }).filter(Boolean) as { food_name: string; portion: string; grams: number; protein: number; carbs: number; fat: number; fiber: number; calories: number }[];
        const total = items.reduce((s, x) => ({ calories: s.calories + x.calories, protein: s.protein + x.protein }), { calories: 0, protein: 0 });
        return { meal_type: (m as Record<string, string>).meal_type, items, calories: r0(total.calories), protein: r1(total.protein) };
      }).filter((m) => m.items.length);
    return { day: di + 1, meals, calories: r0(meals.reduce((s, m) => s + m.calories, 0)), protein: r1(meals.reduce((s, m) => s + m.protein, 0)) };
  }).filter((d) => d.meals.length);
  return {
    days: outDays,
    grocery: (Array.isArray(r.grocery) ? r.grocery : []).slice(0, 80)
      .map((g) => ({ item: txt((g as Record<string, unknown>)?.item, 60), quantity: txt((g as Record<string, unknown>)?.quantity, 40), category: txt((g as Record<string, unknown>)?.category, 30).toLowerCase() || 'other' }))
      .filter((g) => g.item),
    notes: txt(r.notes, 500),
  };
}
