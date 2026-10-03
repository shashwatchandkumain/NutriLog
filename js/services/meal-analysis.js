// One pipeline for every way of logging food (typed, spoken, photo): each food item is resolved
// on its own —
//   1. the meal is read on the device (or, for free-form text, by a small AI parse);
//   2. every food is looked up in the shared Global Food Database;
//   3. only the foods it doesn't know are sent to AI for an estimate.
// Known foods never cost an AI call for their nutrition, and amounts are calculated locally.
import { uuid, UserError } from '../lib/utils.js';
import { nameKey } from '../lib/food-key.js';
import { parseMealText, parseChunk, normalizeUnit } from '../lib/meal-parser.js';
import { portionFor, isSafeFuzzyMatch, nutritionFor } from '../lib/food-resolve.js';
import { resolveFoodNames, rememberFood, proposeAlias, recordResolution } from './food-db.js';
import { parseMealWithAi, estimateFoodsWithAi, analyzeFoodImage } from './ai.js';

const CONFIDENCE = { high: 0.9, medium: 0.7, low: 0.4 };

/** The database food for a lookup result: an exact/alias match, or a clearly safe fuzzy one. */
function pick(result) {
  if (result?.food) return result.food;
  const best = result?.candidates?.[0];
  return best && isSafeFuzzyMatch(result.query, best.food?.name_key) ? best.food : null;
}

/** A review item for a database food. */
function fromDatabase(food, entry) {
  const portion = entry.grams != null
    ? { grams: entry.grams, quantity: entry.grams, servingLabel: food.base_unit || 'g', needsAmount: false, note: null }
    : portionFor(food, entry);
  return { uid: uuid(), source: food.status === 'verified' ? 'global' : 'pending', food, name: food.name, said: entry.said || '', preparation: entry.preparation || null, ...portion, modifierOf: entry.modifierOf ?? null };
}

/** A review item for an AI estimate (a food the database doesn't have yet). */
function fromEstimate(est, entry, aiSource) {
  const per = est.per_100g;
  const food = { id: null, name: est.food_name, category: est.category || null, preparation: entry.preparation || null, base_unit: 'g',
    calories: per.calories, protein: per.protein, carbs: per.carbs, fat: per.fat, fiber: per.fiber, alcohol: per.alcohol || 0,
    sugar: per.sugar ?? null, saturated_fat: per.saturated_fat ?? null, sodium_mg: per.sodium_mg ?? null, cholesterol_mg: per.cholesterol_mg ?? null,
    micros: {}, servings: (est.servings || []).map((s, i) => ({ ...s, is_default: i === 0 })), status: 'ai' };
  const portion = entry.vague
    ? { grams: null, quantity: null, servingLabel: null, needsAmount: true, note: null }
    : { grams: est.grams, quantity: est.grams, servingLabel: 'g', needsAmount: false, note: null };
  return { uid: uuid(), source: 'ai', aiSource, food, name: est.food_name, said: entry.said || '', preparation: entry.preparation || null,
    confidence: est.confidence || 'medium', share: true, ...portion, modifierOf: entry.modifierOf ?? null };
}

/** Links "with" items to the review item they belong to (by uid). */
function linkModifiers(items, entries) {
  const byEntry = new Map(entries.map((e, i) => [i, e._item]));
  for (const e of entries) {
    const it = e._item;
    if (!it) continue;
    const target = e.modifierOf != null ? byEntry.get(e.modifierOf) : null;
    // Only show "with …" for add-ons (butter on an egg), not "roti with eggs".
    const addOn = it.needsAmount || ['fats', 'sweeteners'].includes(it.food?.category) || (it.grams != null && it.grams <= 30);
    it.modifierOf = target && target !== it && addOn ? target.uid : null;
  }
  return items;
}

/** Resolves entries against the database, estimating only the unknown ones with AI. */
async function resolveEntries(entries, { aiSource, stats }) {
  const lookups = await resolveFoodNames(entries.map((e) => e.name));
  const unknown = [];
  entries.forEach((e, i) => {
    const food = pick(lookups[i]);
    if (food) {
      e._item = fromDatabase(food, e);
      stats.global++;
      if (e.fromAiParse) {
        // "anda" → Boiled egg: remember it here, and suggest it as a shared alias.
        const core = parseChunk(e.saidCore || '').name;
        if (core && nameKey(core) !== food.name_key) { rememberFood(core, food); proposeAlias(core, food.id); }
      }
    } else unknown.push(e);
  });
  let provider = null;
  if (unknown.length) {
    if (!navigator.onLine) throw new UserError(`${unknown.map((e) => e.name).join(', ')} ${unknown.length === 1 ? "isn't" : "aren't"} saved on this device yet — connect to the internet to look ${unknown.length === 1 ? 'it' : 'them'} up.`);
    const res = await estimateFoodsWithAi(unknown.map((e) => ({ food_name: e.name, preparation: e.preparation || null, quantity: e.quantity, unit: e.unit, text_span: e.said })));
    stats.aiCalls++;
    provider = res.provider;
    const byIndex = new Map(res.items.map((it) => [it.index, it]));
    // The AI's standard name may be a food NutriLog already knows ("ande" → "Boiled egg").
    const second = await resolveFoodNames(unknown.map((e, j) => byIndex.get(j)?.food_name || e.name)).catch(() => []);
    unknown.forEach((e, j) => {
      const est = byIndex.get(j);
      const known = pick(second[j]);
      if (known) {
        e._item = fromDatabase(known, e);
        stats.global++;
        rememberFood(e.name, known);
        proposeAlias(e.name, known.id);
      } else if (est) {
        e._item = fromEstimate(est, e, aiSource);
        stats.ai++;
      }
    });
  }
  return provider;
}

/**
 * Typed or spoken meal → { items, provider, stats } where stats = { global, ai, aiCalls }.
 * Items are in the order the user said them; every one comes from the database or AI.
 */
export async function analyzeMealText(text) {
  const stats = { global: 0, external: 0, ai: 0, aiCalls: 0 };
  let provider = null;
  const local = parseMealText(text);
  let entries;
  if (local.complete) {
    entries = local.items.map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit, vague: i.vague, modifierOf: i.modifierOf, said: i.text, saidCore: i.text }));
  } else {
    if (!navigator.onLine) throw new UserError("Couldn't read that offline. Try a simpler form, like “2 roti and 1 katori dal”, or connect to the internet.");
    const res = await parseMealWithAi(text);
    stats.aiCalls++;
    provider = res.provider;
    entries = res.items.map((i) => ({ name: i.food_name, quantity: i.quantity, unit: normalizeUnit(i.unit), vague: i.amount_vague, modifierOf: i.modifier_of,
      preparation: i.preparation, said: i.text_span, saidCore: i.text_span, fromAiParse: true }));
  }
  if (!entries.length) return { items: [], provider, stats };
  provider = (await resolveEntries(entries, { aiSource: 'ai_text', stats })) || provider;
  const items = linkModifiers(entries.map((e) => e._item).filter(Boolean), entries);
  recordResolution(stats);
  return { items, provider, stats };
}

/**
 * Foods named by AI with its own estimate (from a photo or the coach) → review items: foods the
 * database knows take the database's nutrition (with the AI's portion); the rest stay estimates.
 */
export async function reviewItemsFromAi(aiItems, aiSource) {
  const stats = { global: 0, external: 0, ai: 0, aiCalls: 0 };
  const lookups = await resolveFoodNames(aiItems.map((i) => i.food_name)).catch(() => aiItems.map(() => null));
  const items = aiItems.map((it, i) => {
    const food = pick(lookups[i]);
    const entry = { said: it.portion_description || '', grams: it.grams };
    if (food) { stats.global++; return fromDatabase(food, entry); }
    stats.ai++;
    return fromEstimate({ food_name: it.food_name, grams: it.grams, per_100g: it.per_100g, servings: [], confidence: it.confidence }, entry, aiSource);
  });
  return { items, stats };
}

/** Photo → the same flow: AI names the foods and portions; known foods take database nutrition. */
export async function analyzeMealPhoto(image, note = '') {
  const res = await analyzeFoodImage(image, note);
  const { items, stats } = await reviewItemsFromAi(res.items, 'ai_photo');
  stats.aiCalls = 1;
  recordResolution(stats);
  return { items, provider: res.provider, stats };
}

/** Nutrition of a review item for its current amount. */
export const itemNutrition = (item) => nutritionFor(item.food, item.grams || 0);

/** Review item → the row saved in the user's log (with a nutrition snapshot). */
export function toLogItem(item) {
  const n = itemNutrition(item);
  const unit = item.servingLabel && !['g', 'ml'].includes(item.servingLabel) ? item.servingLabel.replace(/^1\s+/, '').slice(0, 60) : (item.food.base_unit || 'g');
  const micros = Object.fromEntries(Object.entries(n.micros).map(([k, v]) => [k, Math.round(v * 1000) / 1000]));
  return {
    food_name: item.name, source: item.source === 'ai' ? item.aiSource || 'ai_text' : 'global',
    quantity: unit === (item.food.base_unit || 'g') ? Math.round(item.grams * 100) / 100 : item.quantity, unit, grams: item.grams,
    calories: n.calories, protein: n.protein, carbs: n.carbs, fat: n.fat, fiber: n.fiber,
    food_ref: item.food.id || null, micros: Object.keys(micros).length ? micros : null,
  };
}

/** An AI-estimated food the user confirmed, as a candidate for the shared database. */
export function toCandidate(item) {
  const f = item.food;
  return { name: item.name, category: f.category, preparation: item.preparation, base_unit: f.base_unit || 'g',
    protein: f.protein, carbs: f.carbs, fat: f.fat, fiber: f.fiber, alcohol: f.alcohol || 0,
    sugar: f.sugar, saturated_fat: f.saturated_fat, sodium_mg: f.sodium_mg, cholesterol_mg: f.cholesterol_mg,
    servings: f.servings.map((s) => ({ label: s.label, grams: s.grams })), confidence: CONFIDENCE[item.confidence] ?? 0.7, source_type: 'ai_assisted' };
}
