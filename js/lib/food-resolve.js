// Portions and nutrition for foods from the Global Food Database. A food stores nutrition per
// 100 g (or 100 ml) plus servings ("1 large egg" = 50 g); every amount the user picks is turned
// into grams and scaled linearly — on the device, no AI. Pure functions, unit-tested.
import { nameKey } from './food-key.js';

const MACROS = ['calories', 'protein', 'carbs', 'fat', 'fiber'];
const EXTRAS = ['sugar', 'saturated_fat', 'trans_fat', 'sodium_mg', 'cholesterol_mg'];

/** Which serving words match a unit the user typed ("katori" ↔ "bowl", "tsp" ↔ "teaspoon"). */
const UNIT_WORDS = {
  katori: ['katori', 'bowl'], bowl: ['bowl', 'katori'], cup: ['cup', 'mug'], glass: ['glass'], plate: ['plate'],
  slice: ['slice'], tbsp: ['tbsp', 'tablespoon'], tsp: ['tsp', 'teaspoon'], scoop: ['scoop'], handful: ['handful'],
  piece: ['piece', 'medium', 'roti', 'egg'], serving: ['serving'], packet: ['packet', 'pack'], can: ['can'],
};

/** Levenshtein distance (small strings only). */
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

/**
 * Whether a close (fuzzy) database match can be used without asking: every word must match a
 * word of the food (allowing one typo in words of 5+ letters), and the food may not have
 * extra words — so "chapatii" → Roti is fine, but "half fried egg" never becomes "Fried egg".
 */
export function isSafeFuzzyMatch(query, candidateKey) {
  const q = nameKey(query).split(' ').filter(Boolean);
  const c = String(candidateKey || '').split(' ').filter(Boolean);
  if (!q.length || q.length !== c.length) return false;
  const left = [...c];
  for (const w of q) {
    const i = left.findIndex((x) => x === w || (w.length >= 5 && x.length >= 5 && distance(w, x) <= 1));
    if (i < 0) return false;
    left.splice(i, 1);
  }
  return true;
}

/** "1 large egg" for counts; null when the food has no servings. */
export const defaultServing = (food) => (food?.servings || []).find((s) => s.is_default) || food?.servings?.[0] || null;

/** The serving that fits the user's unit ("katori" → "1 katori (bowl)"), if any. */
export function servingForUnit(food, unit) {
  if (!unit) return null;
  const words = UNIT_WORDS[unit] || [unit];
  return (food?.servings || []).find((s) => words.some((w) => new RegExp(`\\b${w}\\b`, 'i').test(s.label))) || null;
}

/**
 * The amount the user asked for, in grams, and how to show it:
 *   { grams, quantity, servingLabel, needsAmount, note }
 * `needsAmount` means the user must choose (e.g. "a little butter") — nothing is guessed.
 */
export function portionFor(food, { quantity = null, unit = null, vague = false } = {}) {
  if (vague) return { grams: null, quantity: null, servingLabel: null, needsAmount: true, note: null };
  const q = quantity > 0 ? quantity : 1;
  if (unit === 'g' || unit === 'ml') return { grams: q, quantity: q, servingLabel: unit, needsAmount: false, note: null };
  if (unit === 'kg' || unit === 'l') return { grams: q * 1000, quantity: q * 1000, servingLabel: unit === 'kg' ? 'g' : 'ml', needsAmount: false, note: null };
  const byUnit = servingForUnit(food, unit);
  if (byUnit) return { grams: q * byUnit.grams, quantity: q, servingLabel: byUnit.label, needsAmount: false, note: null };
  const def = defaultServing(food);
  if (!def) return { grams: null, quantity: null, servingLabel: null, needsAmount: true, note: null };
  return { grams: q * def.grams, quantity: q, servingLabel: def.label, needsAmount: false,
    note: unit && unit !== 'piece' && unit !== 'serving' ? `“${unit}” isn't a saved serving for ${food.name}; using ${def.label}` : null };
}

/** Nutrition for `grams` of a food (unrounded). Micronutrients unknown for the food stay unknown. */
export function nutritionFor(food, grams) {
  const f = (Number(grams) || 0) / 100;
  const out = {};
  for (const k of MACROS) out[k] = (Number(food?.[k]) || 0) * f;
  for (const k of EXTRAS) out[k] = food?.[k] == null ? null : Number(food[k]) * f;
  out.micros = {};
  for (const [k, v] of Object.entries(food?.micros || {})) if (v != null && Number.isFinite(Number(v))) out.micros[k] = Number(v) * f;
  return out;
}

/** Display text for an amount: "4 × 1 large egg (200 g)", "150 g". */
export function amountText({ quantity, servingLabel, grams }, unit = 'g') {
  if (grams == null) return 'Choose an amount';
  const g = `${Math.round(grams * 10) / 10} ${unit}`;
  if (!servingLabel || servingLabel === 'g' || servingLabel === 'ml') return g;
  const q = Math.round(quantity * 100) / 100;
  return `${q === 1 ? '' : `${q} × `}${servingLabel} (${g})`;
}

/** Foods are "the same" for merging when they are the same database food, or same name + preparation. */
export function sameFood(a, b) {
  if (a.food?.id && b.food?.id) return a.food.id === b.food.id;
  return nameKey(a.food?.name || a.name) === nameKey(b.food?.name || b.name);
}

/** Merges amount `add` into `item`: same serving → add quantities; otherwise add grams. */
export function mergeAmounts(item, add) {
  if (item.servingLabel && item.servingLabel === add.servingLabel) {
    const quantity = item.quantity + add.quantity;
    return { ...item, quantity, grams: item.grams + add.grams };
  }
  const grams = (item.grams || 0) + (add.grams || 0);
  return { ...item, quantity: grams, servingLabel: 'g', grams };
}
