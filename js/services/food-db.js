// The Global Food Database (shared by every NutriLog user, in Supabase), seen from the app.
// Supabase is the source of truth; foods already looked up are kept on this device so common
// meals resolve instantly — and offline. Nothing here calls AI.
import { sb } from './supabase.js';
import { nameKey } from '../lib/food-key.js';

const CACHE_KEY = 'nutrilog.foods.v1';
const MAX_ENTRIES = 400;
const MAX_AGE = 7 * 86400_000;

let cache = null; // name key → { food, match, at }
function load() {
  if (cache) return cache;
  try { cache = new Map(Object.entries(JSON.parse(localStorage.getItem(CACHE_KEY)) || {})); } catch { cache = new Map(); }
  return cache;
}
function save() {
  try {
    const entries = [...load().entries()].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_ENTRIES);
    cache = new Map(entries);
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch { /* storage full or unavailable — the cache is only a speed-up */ }
}
/** Forgets cached foods (e.g. after logging out). */
export function clearFoodCache() { cache = new Map(); try { localStorage.removeItem(CACHE_KEY); } catch { /* ignore */ } }

function rpc(name, args) {
  if (!sb) return Promise.reject(new Error('not configured'));
  return sb.rpc(name, args).then(({ data, error }) => {
    if (error) throw Object.assign(new Error(error.message), { code: error.code });
    return data;
  });
}

/**
 * Looks names up in the shared database. Returns, per name:
 *   { query, key, match: 'exact' | 'alias' | null, food, candidates: [{ score, food }], cached }
 * Verified foods (and the user's own pending ones) only — the server applies the rules.
 */
export async function resolveFoodNames(names) {
  const c = load();
  const now = Date.now();
  const out = names.map((query) => {
    const key = nameKey(query);
    const hit = c.get(key);
    return hit && now - hit.at < MAX_AGE && hit.food?.status === 'verified'
      ? { query, key, match: hit.match, food: hit.food, candidates: [], cached: true }
      : { query, key, match: null, food: null, candidates: [], cached: false };
  });
  const missing = out.filter((r) => !r.cached && r.key);
  if (missing.length && navigator.onLine) {
    const res = await rpc('resolve_foods', { p_names: missing.map((r) => r.query) });
    res.forEach((r, i) => {
      const target = missing[i];
      target.match = r.match || null;
      target.food = r.food || null;
      target.candidates = r.candidates || [];
      if (r.food) c.set(target.key, { food: r.food, match: r.match, at: now });
    });
    save();
  }
  return out;
}

/** Remembers a food under another name the user used (e.g. after an AI parse). */
export function rememberFood(name, food) {
  const key = nameKey(name);
  if (!key || !food || food.status !== 'verified') return;
  load().set(key, { food, match: 'alias', at: Date.now() });
  save();
}

/** Search for the food pickers ("egg" → Boiled egg, Fried egg, Omelette…). */
export async function searchGlobalFoods(query, limit = 12) {
  if (!navigator.onLine || nameKey(query).length < 2) return [];
  return (await rpc('search_foods', { p_query: query, p_limit: limit })) || [];
}

/** A packaged food already in the database, by barcode. */
export async function foodByBarcode(code) {
  if (!navigator.onLine) return null;
  return rpc('food_by_source', { p_source_id: `off:${code}` }).catch(() => null);
}

/** One shared food by id (for reports from the log). */
export async function foodById(id) {
  if (!sb || !id) return null;
  const { data, error } = await sb.from('foods').select('*, servings:food_servings(label, grams, is_default)').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/** Counts how a meal's foods were resolved (for the AI-usage dashboard). Fire and forget. */
export function recordResolution({ global = 0, external = 0, ai = 0, aiCalls = 0 }) {
  if (!navigator.onLine || !(global + external + ai)) return;
  rpc('record_food_resolution', { p_global: global, p_external: external, p_ai_items: ai, p_ai_calls: aiCalls })
    .catch((e) => console.warn('[NutriLog] food stats', e.message));
}

/** "anda" meant Boiled egg: suggest it as a shared alias (added once two users agree). */
export function proposeAlias(alias, foodId) {
  if (!navigator.onLine || !foodId) return;
  rpc('propose_food_alias', { p_alias: alias, p_food: foodId }).catch((e) => console.warn('[NutriLog] alias', e.message));
}

// ── Admin ────────────────────────────────────────────────────────────────
export const isAdmin = () => rpc('is_admin', {}).then(Boolean).catch(() => false);
export const adminOverview = () => rpc('admin_overview', {});
export const adminSetStatus = (id, status) => rpc('admin_set_food_status', { p_food: id, p_status: status });
export const adminUpdateFood = (id, patch) => rpc('admin_update_food', { p_food: id, p_patch: patch });
export const adminReviewCorrection = (id, approve) => rpc('admin_review_correction', { p_id: id, p_approve: approve });
export const adminMergeFoods = (from, into) => rpc('admin_merge_foods', { p_from: from, p_into: into });
export const adminAddAlias = (foodId, alias) => rpc('admin_add_alias', { p_food: foodId, p_alias: alias });
export const adminRejectAlias = (aliasKey) => rpc('admin_reject_alias', { p_alias_key: aliasKey });
