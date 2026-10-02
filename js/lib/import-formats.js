// Reads profile backups for "Settings → Import a profile". Pure functions (no DOM, no network).
//   • NutriLog export (Settings → Export → JSON) — from this or any other NutriLog account
//   • Smart-scale backup from the occult app (Export JSON) — one or more household profiles
// Every value is validated against the database's limits, so an import can't fail halfway on
// one bad row; anything invalid is skipped.
import { isoDate, uuidFrom } from './utils.js';

const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];
const ITEM_SOURCES = ['database', 'ai_text', 'ai_photo', 'barcode', 'manual', 'chat', 'legacy'];
const ACTIVITY_SOURCES = ['preset', 'ai', 'manual', 'legacy'];
const GOALS = ['lose', 'maintain', 'gain', 'muscle'];
const LEVELS = ['sedentary', 'light', 'moderate', 'active', 'very_active'];
const DIETS = ['vegetarian', 'eggetarian', 'non_vegetarian', 'vegan'];
const STYLES = ['balanced', 'high_protein', 'low_carb', 'keto'];

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const num = (v, lo, hi) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
};
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const oneOf = (v, list, fallback = null) => (list.includes(v) ? v : fallback);

/** 'nutrilog' | 'scale' | null */
export function detectFormat(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.app === 'NutriLog' && ['meal_items', 'weight_history', 'activities', 'water_logs'].some((k) => Array.isArray(data[k]))) return 'nutrilog';
  if (Array.isArray(data.profiles) && Array.isArray(data.readings)) return 'scale';
  return null;
}

// ── Smart-scale (occult) backups ──────────────────────────────────────────

/** The profiles in a smart-scale backup, with their number of readings. */
export function scaleProfiles(data, now = new Date()) {
  const counts = new Map();
  for (const r of data.readings || []) counts.set(r?.profileId, (counts.get(r?.profileId) || 0) + 1);
  return (data.profiles || []).filter((p) => p && p.id != null).map((p) => {
    const birthYear = num(p.birthYear, 1900, now.getFullYear());
    return {
      id: p.id,
      name: text(p.name, 80) || 'Unnamed',
      sex: oneOf(p.sex, ['male', 'female']),
      age: birthYear ? num(now.getFullYear() - birthYear, 13, 120) : null,
      heightCm: num(p.heightCm, 90, 250),
      readings: counts.get(p.id) || 0,
    };
  });
}

/**
 * Weigh-ins for one scale profile — one per local day (the day's latest reading), oldest first:
 * [{ date, kg, measuredAt, heartRate }]
 */
export function scaleWeighIns(data, profileId) {
  const byDay = new Map();
  for (const r of data.readings || []) {
    if (r?.profileId !== profileId) continue;
    const kg = num(r.weightKg, 20, 400);
    const at = new Date(r.ts);
    if (kg == null || Number.isNaN(at.getTime())) continue;
    const date = isoDate(at);
    const prev = byDay.get(date);
    if (!prev || at > prev.at) byDay.set(date, { date, kg: r2(kg), at, heartRate: num(r.heartRate, 30, 230) });
  }
  return [...byDay.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(({ at, ...w }) => ({ ...w, measuredAt: at.toISOString() }));
}

/** Profile fields from a scale profile (sex, age, height). */
export function scaleProfilePatch(p) {
  const patch = {};
  if (p.sex) patch.sex = p.sex;
  if (p.age) patch.age = p.age;
  if (p.heightCm) patch.height_cm = r2(p.heightCm);
  return patch;
}

// ── NutriLog exports ──────────────────────────────────────────────────────

/** What a NutriLog export contains, for the import screen. */
export function nutrilogSummary(data) {
  const p = data.profile || {};
  return {
    name: text(p.display_name, 80) || null,
    email: text(data.account?.email, 200) || null,
    exportedAt: data.exported_at || null,
    weights: (data.weight_history || []).length,
    items: (data.meal_items || []).length,
    activities: (data.activities || []).length,
    water: (data.water_logs || []).length,
    favorites: (data.favorite_foods || []).length,
    hasProfile: !!data.profile,
    hasGoals: !!data.daily_goals?.calories,
  };
}

/** Profile columns from a NutriLog export, validated. */
export function nutrilogProfilePatch(data) {
  const p = data.profile || {};
  const patch = {
    display_name: text(p.display_name, 80) || null,
    age: num(p.age, 13, 120),
    sex: oneOf(p.sex, ['male', 'female']),
    height_cm: r2(num(p.height_cm, 90, 250)),
    target_weight_kg: r2(num(p.target_weight_kg, 25, 400)),
    target_date: isDate(p.target_date) ? p.target_date : null,
    goal: oneOf(p.goal, GOALS, 'maintain'),
    activity_level: oneOf(p.activity_level, LEVELS, 'sedentary'),
    daily_steps: num(p.daily_steps, 0, 100000),
    workouts_per_week: num(p.workouts_per_week, 0, 14),
    diet_type: oneOf(p.diet_type, DIETS),
    macro_style: oneOf(p.macro_style, STYLES, 'balanced'),
    allergies: Array.isArray(p.allergies) ? p.allergies.map((a) => text(a, 40)).filter(Boolean).slice(0, 20) : [],
  };
  if (patch.daily_steps != null) patch.daily_steps = Math.round(patch.daily_steps);
  if (patch.workouts_per_week != null) patch.workouts_per_week = Math.round(patch.workouts_per_week);
  if (patch.age != null) patch.age = Math.round(patch.age);
  return patch;
}

/** Nutrition targets from a NutriLog export, or null. */
export function nutrilogGoals(data) {
  const g = data.daily_goals || {};
  const calories = num(g.calories, 800, 10000);
  if (calories == null) return null;
  return {
    calories: Math.round(calories),
    protein: num(g.protein_g, 0, 600) ?? 0,
    carbs: num(g.carbs_g, 0, 1500) ?? 0,
    fat: num(g.fat_g, 0, 600) ?? 0,
    fiber: num(g.fiber_g, 0, 150) ?? 0,
    isCustom: !!g.is_custom,
  };
}

/**
 * Weigh-ins from a NutriLog export: [{ date, kg, measuredAt, heartRate, composition }] where
 * composition holds the exported body-composition snapshot (or null for older exports).
 */
export function nutrilogWeighIns(data) {
  const out = new Map();
  for (const w of data.weight_history || []) {
    const kg = num(w?.weight_kg, 20, 400);
    if (!isDate(w?.recorded_on) || kg == null) continue;
    const c = {
      bmi: r2(num(w.bmi, 5, 150)), body_fat_pct: r2(num(w.body_fat_pct, 0, 80)), fat_mass_kg: r2(num(w.fat_mass_kg, 0, 400)),
      lean_mass_kg: r2(num(w.lean_mass_kg, 0, 400)), body_water_pct: r2(num(w.body_water_pct, 0, 100)),
      body_water_l: r2(num(w.body_water_l, 0, 300)), bmr_kcal: r2(num(w.bmr_kcal, 0, 10000)),
    };
    out.set(w.recorded_on, {
      date: w.recorded_on, kg: r2(kg),
      measuredAt: w.measured_at && !Number.isNaN(Date.parse(w.measured_at)) ? w.measured_at : null,
      heartRate: num(w.heart_rate_bpm, 30, 230),
      composition: c.bmi != null ? c : null,
    });
  }
  return [...out.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Food log rows from a NutriLog export, with new deterministic ids for `userId`. */
export async function nutrilogItems(data, userId) {
  const out = [];
  for (const it of data.meal_items || []) {
    const name = text(it?.food_name, 200);
    const calories = num(it?.calories, 0, 20000);
    if (!name || !isDate(it?.meal_date) || calories == null) continue;
    const macro = (k) => r2(num(it[k], 0, 2000) ?? 0);
    out.push({
      id: await uuidFrom(`${userId}:item:${it.id ?? `${it.meal_date}:${name}:${out.length}`}`),
      meal_date: it.meal_date,
      meal_type: oneOf(it.meal_type, MEAL_TYPES, 'snack'),
      food_id: it.food_id ? text(it.food_id, 100) : null,
      food_name: name,
      source: oneOf(it.source, ITEM_SOURCES, 'manual'),
      quantity: r2(num(it.quantity, 0.01, 10000) ?? 1),
      unit: text(it.unit, 60) || 'g',
      grams: r2(num(it.grams, 0, 20000)),
      calories: r2(calories), protein: macro('protein'), carbs: macro('carbs'), fat: macro('fat'), fiber: macro('fiber'),
    });
  }
  return out;
}

/** Activities from a NutriLog export, with new deterministic ids for `userId`. */
export async function nutrilogActivities(data, userId) {
  const out = [];
  for (const a of data.activities || []) {
    const name = text(a?.name, 120);
    if (!name || !isDate(a?.activity_date)) continue;
    out.push({
      id: await uuidFrom(`${userId}:activity:${a.id ?? `${a.activity_date}:${name}:${out.length}`}`),
      activity_date: a.activity_date,
      name,
      duration_min: Math.round(num(a.duration_min, 0, 1440) ?? 0),
      met: r2(num(a.met, 1, 25)),
      calories_burned: r2(num(a.calories_burned, 0, 10000) ?? 0),
      source: oneOf(a.source, ACTIVITY_SOURCES, 'manual'),
    });
  }
  return out;
}

/** Water logs from a NutriLog export, in ml (older exports stored 250 ml glasses). */
export function nutrilogWater(data) {
  return (data.water_logs || []).map((w) => {
    if (!isDate(w?.log_date)) return null;
    const ml = num(w.ml, 0, 20000) ?? (num(w.glasses, 0, 40) != null ? Number(w.glasses) * 250 : null);
    return ml == null ? null : { log_date: w.log_date, ml: Math.round(ml) };
  }).filter(Boolean);
}

/** Favorite foods from a NutriLog export (name + portion + nutrition for that portion). */
export function nutrilogFavorites(data) {
  const out = new Map();
  for (const f of data.favorite_foods || []) {
    const name = text(f?.food_name, 200);
    const calories = num(f?.calories, 0, 20000);
    if (!name || calories == null) continue;
    const unit = text(f.unit, 60) || 'g';
    const macro = (k) => r2(num(f[k], 0, 2000) ?? 0);
    out.set(`${name.toLowerCase()}|${unit}`, { food_name: name, quantity: r2(num(f.quantity, 0.01, 10000) ?? 1), unit, grams: r2(num(f.grams, 0, 20000)),
      calories: r2(calories), protein: macro('protein'), carbs: macro('carbs'), fat: macro('fat'), fiber: macro('fiber') });
  }
  return [...out.values()];
}
