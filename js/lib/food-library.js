// "My foods": the user's own recent and favorite foods, for one-tap re-logging and search.
// There is no generic food database — everything here comes from what the user logged or
// saved, with the exact portion and nutrition they used. Pure functions (no DOM, no network).
import { NUTRIENTS } from './nutrition.js';

/** Lower-case, accent- and punctuation-free text for matching. */
export function normalizeName(s) {
  return String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Identity of a food in "my foods": same name and unit = same food. */
export const foodKey = (name, unit) => `${normalizeName(name)}|${String(unit || 'g').trim().toLowerCase()}`;

const num = (v) => Math.max(0, Number(v) || 0);

/** A food (name + the portion logged + nutrition for that portion) from a meal item or favorite. */
export function foodFrom(row) {
  const food = {
    key: foodKey(row.food_name, row.unit),
    food_name: String(row.food_name || '').trim(),
    quantity: Number(row.quantity) > 0 ? Number(row.quantity) : 1,
    unit: String(row.unit || 'g').trim() || 'g',
    grams: row.grams == null ? null : num(row.grams),
    food_ref: row.food_ref || null, // the Global Food Database food it came from, if any
  };
  for (const k of NUTRIENTS) food[k] = num(row[k]);
  return food;
}

/**
 * Recently logged foods, newest first, one per name + unit, each with the portion the user
 * logged most recently. `items` are meal items with created_at (any order).
 */
export function recentFoods(items, limit = 40) {
  const sorted = [...(items || [])].sort((a, b) => String(b.created_at || b.meal_date || '').localeCompare(String(a.created_at || a.meal_date || '')));
  const seen = new Map();
  for (const it of sorted) {
    if (!it?.food_name) continue;
    const f = foodFrom(it);
    if (!seen.has(f.key)) seen.set(f.key, { ...f, lastLogged: it.meal_date || null, timesLogged: 1 });
    else seen.get(f.key).timesLogged++;
    if (seen.size >= limit * 3) break;
  }
  return [...seen.values()].slice(0, limit);
}

/**
 * Searches foods by name: every word of the query must appear; names that start with the
 * query rank first, then word starts, then anywhere. Ties keep the incoming order (recency).
 */
export function searchFoods(foods, query, limit = 30) {
  const q = normalizeName(query);
  if (!q) return foods.slice(0, limit);
  const words = q.split(' ');
  const scored = [];
  foods.forEach((f, i) => {
    const name = normalizeName(f.food_name);
    if (!words.every((w) => name.includes(w))) return;
    const score = name.startsWith(q) ? 0 : name.split(' ').some((w) => w.startsWith(words[0])) ? 1 : 2;
    scored.push({ f, score, i });
  });
  return scored.sort((a, b) => a.score - b.score || a.i - b.i).slice(0, limit).map((s) => s.f);
}

/**
 * Nutrition for `quantity` of a food, scaled linearly from the logged portion
 * (e.g. 1.5 plates of a 1-plate food = 1.5 × its nutrition). Not rounded.
 */
export function scaleFood(food, quantity) {
  const q = Number(quantity);
  const f = q > 0 ? q / (Number(food.quantity) || 1) : 0;
  const out = { food_name: food.food_name, quantity: q > 0 ? q : 0, unit: food.unit, grams: food.grams == null ? null : food.grams * f, food_ref: food.food_ref || null };
  for (const k of NUTRIENTS) out[k] = (Number(food[k]) || 0) * f;
  return out;
}

/** Merges favorites into a list: favorites first (newest saved first), then other recent foods. */
export function withFavorites(recent, favorites) {
  const favKeys = new Set((favorites || []).map((f) => foodKey(f.food_name, f.unit)));
  const favs = [...(favorites || [])].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .map((f) => ({ ...foodFrom(f), favoriteId: f.id, favorite: true }));
  return [...favs, ...recent.filter((r) => !favKeys.has(r.key))];
}
