// Data layer: reads from Supabase, caches locally for instant/offline display, and sends
// writes through a persistent queue so nothing is lost offline and retries never duplicate.
//
// Writes are optimistic: the local view updates immediately, the queued operation is sent
// when online. Every operation is idempotent on the server (client-generated ids, upserts,
// ON CONFLICT DO NOTHING), so a retry after a lost response can't create duplicates.
import { sb } from './supabase.js';
import { state, emit, effectiveProfile } from '../store.js';
import { uuid, today, addDays, UserError, friendlyError } from '../lib/utils.js';
import { recommendTargets } from '../lib/nutrition.js';
import { bodyComposition } from '../lib/body-composition.js';
import { netActivityCalories, weightOn } from '../lib/activity.js';
import { foodKey, recentFoods } from '../lib/food-library.js';

let uid = null;
let queue = [];
let failed = [];   // changes the server rejected — kept so the user can retry or discard them
let flushing = false;
let retryTimer = null;
let retryDelay = 2000;
let cache = { days: {} };
const CACHE_VERSION = 2; // v2: water is stored in ml

const LS = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota or blocked */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const queueKey = () => `nutrilog.queue.${uid}`;
const failedKey = () => `nutrilog.failed.${uid}`;
const cacheKey = () => `nutrilog.cache.${uid}`;
const MAX_CACHED_DAYS = 21;

// ── Session lifecycle ─────────────────────────────────────────────────────
export function startDataSession(userId) {
  uid = userId;
  queue = LS.get(queueKey()) || [];
  failed = LS.get(failedKey()) || [];
  cache = LS.get(cacheKey()) || { days: {} };
  if (cache.v !== CACHE_VERSION) cache = { v: CACHE_VERSION, days: {} };
  cache.days ||= {};
  state.pending = queue.length;
  state.failed = failed.length;
  if (cache.profile) state.profile = cache.profile;
  if (cache.prefs) state.prefs = cache.prefs;
  if (cache.goals) state.goals = cache.goals;
  if (cache.weights) state.weights = cache.weights;
  if (cache.loggedDates) state.loggedDates = cache.loggedDates;
  if (cache.favoritesBase) state.favorites = overlayFavorites(cache.favoritesBase);
  flush();
}

/** Clears everything cached for the user on this device (logout / account deletion). */
export function endDataSession({ keepQueue = false } = {}) {
  if (uid) {
    LS.del(cacheKey());
    if (!keepQueue) { LS.del(queueKey()); LS.del(failedKey()); }
  }
  uid = null; queue = []; failed = []; cache = { v: CACHE_VERSION, days: {} };
  clearTimeout(retryTimer);
  state.pending = 0;
  state.failed = 0;
}

let saveTimer;
function saveCache() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!uid) return;
    const dates = Object.keys(cache.days).sort().reverse();
    for (const d of dates.slice(MAX_CACHED_DAYS)) delete cache.days[d];
    LS.set(cacheKey(), { ...cache, v: CACHE_VERSION });
  }, 300);
}

// ── Supabase result helpers ───────────────────────────────────────────────
function check({ data, error, status }) {
  if (error) {
    const e = new Error(error.message || 'Database error');
    e.code = error.code; e.status = status; e.details = error.details;
    throw e;
  }
  return data;
}

/** Fetches all rows of a query in pages of 1000 (PostgREST's default row limit). */
async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const rows = check(await build().range(from, from + 999));
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

// ── Profile / preferences / goals ─────────────────────────────────────────
export async function loadAccount() {
  const [p, pr, g] = await Promise.all([
    sb.from('profiles').select('*').eq('id', uid).maybeSingle(),
    sb.from('user_preferences').select('*').eq('user_id', uid).maybeSingle(),
    sb.from('daily_goals').select('*').eq('user_id', uid).maybeSingle(),
  ]);
  let profile = check(p), prefs = check(pr), goals = check(g);
  // Rows are normally created by the database trigger; create them if it isn't installed.
  if (!profile) profile = check(await sb.from('profiles').upsert({ id: uid }).select().single());
  if (!prefs) prefs = check(await sb.from('user_preferences').upsert({ user_id: uid }).select().single());
  if (!goals) goals = check(await sb.from('daily_goals').upsert({ user_id: uid }).select().single());
  Object.assign(state, { profile, prefs, goals });
  Object.assign(cache, { profile, prefs, goals });
  saveCache();
  emit('account');
  return { profile, prefs, goals };
}

export async function saveProfile(patch) {
  const profile = check(await sb.from('profiles').update(patch).eq('id', uid).select().single());
  state.profile = cache.profile = profile;
  saveCache(); emit('account');
  return profile;
}

export async function savePrefs(patch) {
  const prefs = check(await sb.from('user_preferences').update(patch).eq('user_id', uid).select().single());
  state.prefs = cache.prefs = prefs;
  saveCache(); emit('account');
  return prefs;
}

export async function saveGoals({ calories, protein, carbs, fat, fiber, isCustom }) {
  const goals = check(await sb.from('daily_goals').update({
    calories: Math.round(calories), protein_g: protein, carbs_g: carbs, fat_g: fat, fiber_g: fiber, is_custom: !!isCustom,
  }).eq('user_id', uid).select().single());
  state.goals = cache.goals = goals;
  saveCache(); emit('account');
  return goals;
}

// ── Day data ──────────────────────────────────────────────────────────────
const emptyDay = () => ({ items: [], activities: [], water: 0 });

/** Applies queued (not yet synced) operations on top of server data for one date. */
function overlayDay(day, date) {
  const d = { items: [...day.items], activities: [...day.activities], water: day.water };
  for (const op of queue) {
    if (op.date !== date) continue;
    switch (op.t) {
      case 'log':
        for (const it of op.items) if (!d.items.some((x) => x.id === it.id)) d.items.push({ ...it, meal_date: date, meal_type: op.mealType, pending: true });
        break;
      case 'deleteItem': d.items = d.items.filter((x) => x.id !== op.id); break;
      case 'updateItem': d.items = d.items.map((x) => (x.id === op.id ? { ...x, ...op.patch, meal_type: op.mealType || x.meal_type, pending: true } : x)); break;
      case 'water': d.water = op.ml ?? (op.glasses || 0) * 250; break;
      case 'activity': if (!d.activities.some((x) => x.id === op.row.id)) d.activities.push({ ...op.row, pending: true }); break;
      case 'deleteActivity': d.activities = d.activities.filter((x) => x.id !== op.id); break;
      default: break;
    }
  }
  return d;
}

/** Cached view of a day (instant), or null if never loaded on this device. */
export function cachedDay(date) {
  const d = cache.days[date];
  return d ? overlayDay(d, date) : null;
}

export async function fetchDay(date) {
  const [items, acts, water] = await Promise.all([
    sb.from('meal_items').select('*').eq('meal_date', date).order('created_at'),
    sb.from('activities').select('*').eq('activity_date', date).order('created_at'),
    sb.from('water_logs').select('ml').eq('log_date', date).maybeSingle(),
  ]);
  const day = { items: check(items), activities: check(acts), water: check(water)?.ml ?? 0 };
  cache.days[date] = day;
  saveCache();
  return overlayDay(day, date);
}

function updateCachedDay(date, fn) {
  const base = cache.days[date] || emptyDay();
  cache.days[date] = base;
  if (fn) fn(base);
  saveCache();
  if (date === state.date) { state.day = overlayDay(base, date); emit('day'); }
}

// ── Ranges (charts, progress) ─────────────────────────────────────────────
export async function fetchItemsRange(start, end) {
  const rows = await fetchAll(() => sb.from('meal_items')
    .select('id, meal_date, calories, protein, carbs, fat, fiber')
    .gte('meal_date', start).lte('meal_date', end).order('meal_date'));
  // Include unsynced changes so charts match the dashboard.
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const op of queue) {
    if (!op.date || op.date < start || op.date > end) continue;
    if (op.t === 'log') for (const it of op.items) byId.set(it.id, { ...it, meal_date: op.date });
    if (op.t === 'deleteItem') byId.delete(op.id);
    if (op.t === 'updateItem' && byId.has(op.id)) byId.set(op.id, { ...byId.get(op.id), ...op.patch });
  }
  return [...byId.values()];
}

export async function fetchActivitiesRange(start, end) {
  const rows = await fetchAll(() => sb.from('activities').select('id, activity_date, duration_min, met, calories_burned')
    .gte('activity_date', start).lte('activity_date', end));
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const op of queue) {
    if (!op.date || op.date < start || op.date > end) continue;
    if (op.t === 'activity') byId.set(op.row.id, op.row);
    if (op.t === 'deleteActivity') byId.delete(op.id);
  }
  return [...byId.values()];
}

export async function fetchLoggedDates() {
  const rows = check(await sb.rpc('logged_dates'));
  const set = new Set(rows.map((r) => r.meal_date));
  for (const op of queue) if (op.t === 'log') set.add(op.date);
  state.loggedDates = cache.loggedDates = [...set].sort();
  saveCache();
  emit('streak');
  return state.loggedDates;
}

// ── Weights ───────────────────────────────────────────────────────────────
const WEIGHT_COLUMNS = 'recorded_on, weight_kg, source, measured_at, bmi, body_fat_pct, fat_mass_kg, lean_mass_kg, body_water_pct, body_water_l, bmr_kcal, heart_rate_bpm';
const WEIGHT_NUMERIC = ['weight_kg', 'bmi', 'body_fat_pct', 'fat_mass_kg', 'lean_mass_kg', 'body_water_pct', 'body_water_l', 'bmr_kcal', 'heart_rate_bpm'];

function normalizeWeight(w) {
  const out = { ...w };
  for (const k of WEIGHT_NUMERIC) out[k] = w[k] == null ? null : Number(w[k]);
  return out;
}

function overlayWeights(rows) {
  const map = new Map(rows.map((w) => [w.recorded_on, normalizeWeight(w)]));
  for (const op of queue) {
    if (op.t === 'weight') map.set(op.date, { ...normalizeWeight({ ...op.record, weight_kg: op.kg }), recorded_on: op.date, pending: true });
    if (op.t === 'deleteWeight') map.delete(op.date);
  }
  return [...map.values()].sort((a, b) => a.recorded_on.localeCompare(b.recorded_on));
}

export async function fetchWeights() {
  const rows = await fetchAll(() => sb.from('weight_history').select(WEIGHT_COLUMNS).order('recorded_on'));
  cache.weightsBase = rows;
  state.weights = cache.weights = overlayWeights(rows);
  saveCache();
  emit('weights');
  return state.weights;
}

function refreshLocalWeights() {
  state.weights = cache.weights = overlayWeights(cache.weightsBase || state.weights);
  saveCache();
  emit('weights');
}

const r2 = (v) => Math.round(Number(v) * 100) / 100;
/** Rounds to 2 decimals, or null when the value is missing or outside the column's range. */
const within = (v, lo, hi) => (v != null && Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi ? r2(v) : null);

/**
 * A weigh-in row: the exact weight (0.01 kg) plus a body-composition snapshot computed from
 * `profile` (height, age, sex) at the time of the measurement.
 */
export function weighInRecord(kg, { source = 'manual', measuredAt = null, heartRate = null, profile = state.profile || {} } = {}) {
  const c = bodyComposition({ weightKg: kg, heightCm: profile.height_cm, age: profile.age, sex: profile.sex });
  const hr = Math.round(Number(heartRate));
  return {
    weight_kg: r2(kg),
    source: ['manual', 'scale', 'import', 'legacy'].includes(source) ? source : 'manual',
    measured_at: measuredAt || null,
    bmi: within(c.bmi, 5, 150),
    body_fat_pct: within(c.bodyFatPct, 0, 80),
    fat_mass_kg: within(c.fatMassKg, 0, 400),
    lean_mass_kg: within(c.leanMassKg, 0, 400),
    body_water_pct: within(c.bodyWaterPct, 0, 100),
    body_water_l: within(c.bodyWaterL, 0, 300),
    bmr_kcal: within(c.bmrKcal, 0, 10000),
    heart_rate_bpm: hr >= 30 && hr <= 230 ? hr : null,
  };
}

// ── My foods: favorites and recently logged foods ─────────────────────────
const FOOD_COLUMNS = 'food_name, quantity, unit, grams, calories, protein, carbs, fat, fiber';

function overlayFavorites(rows) {
  const map = new Map(rows.map((f) => [foodKey(f.food_name, f.unit), f]));
  for (const op of queue) {
    if (op.t === 'favorite') map.set(foodKey(op.row.food_name, op.row.unit), { ...op.row, pending: true });
    if (op.t === 'unfavorite') map.delete(foodKey(op.food_name, op.unit));
  }
  return [...map.values()];
}

export async function fetchFavorites() {
  const rows = await fetchAll(() => sb.from('favorite_foods').select(`id, ${FOOD_COLUMNS}, created_at`).order('created_at', { ascending: false }));
  cache.favoritesBase = rows;
  state.favorites = overlayFavorites(rows);
  saveCache();
  emit('favorites');
  return state.favorites;
}

function refreshLocalFavorites() {
  state.favorites = overlayFavorites(cache.favoritesBase || state.favorites || []);
  saveCache();
  emit('favorites');
}

export const isFavorite = (food) => (state.favorites || []).some((f) => foodKey(f.food_name, f.unit) === foodKey(food.food_name, food.unit));

/** Saves a food (name + portion + nutrition for that portion) to favorites. */
export function addFavorite(food) {
  const row = { id: uuid(), food_name: String(food.food_name || '').trim().slice(0, 200), quantity: Number(food.quantity) > 0 ? Number(food.quantity) : 1,
    unit: String(food.unit || 'g').slice(0, 60), grams: food.grams == null ? null : r2(food.grams), created_at: new Date().toISOString() };
  for (const k of ['calories', 'protein', 'carbs', 'fat', 'fiber']) row[k] = r2(Math.max(0, Number(food[k]) || 0));
  if (!row.food_name) return;
  dropQueued((op) => (op.t === 'favorite' || op.t === 'unfavorite') && foodKey(op.food_name ?? op.row?.food_name, op.unit ?? op.row?.unit) === foodKey(row.food_name, row.unit));
  enqueue({ t: 'favorite', date: null, row });
  refreshLocalFavorites();
}

export function removeFavorite(food) {
  const key = foodKey(food.food_name, food.unit || 'g');
  // Matching ignores case and punctuation, but the server deletes by exact name, so remove every
  // stored favorite with this key ("Jeera Rice" and "jeera rice" are the same food here).
  const stored = new Map([...(cache.favoritesBase || []), ...(state.favorites || []), { food_name: String(food.food_name || '').trim(), unit: String(food.unit || 'g') }]
    .filter((f) => foodKey(f.food_name, f.unit) === key).map((f) => [`${f.food_name}\u0000${f.unit}`, f]));
  dropQueued((op) => (op.t === 'favorite' || op.t === 'unfavorite') && foodKey(op.food_name ?? op.row?.food_name, op.unit ?? op.row?.unit) === key);
  for (const f of stored.values()) enqueue({ t: 'unfavorite', date: null, food_name: f.food_name, unit: f.unit });
  if (cache.favoritesBase) cache.favoritesBase = cache.favoritesBase.filter((f) => foodKey(f.food_name, f.unit) !== key);
  refreshLocalFavorites();
}

/**
 * The user's recently logged foods (newest first, one per name + unit), from the server
 * plus anything logged on this device that hasn't synced yet.
 */
export async function fetchRecentFoods({ refresh = true } = {}) {
  if (refresh || !cache.recentItems) {
    const rows = check(await sb.from('meal_items').select(`${FOOD_COLUMNS}, meal_date, created_at`).order('created_at', { ascending: false }).limit(400));
    cache.recentItems = rows;
    saveCache();
  }
  return cachedRecentFoods();
}

/** Instant version of fetchRecentFoods from this device's cache. */
export function cachedRecentFoods() {
  const pending = queue.filter((op) => op.t === 'log').flatMap((op) => op.items.map((it) => ({ ...it, meal_date: op.date, created_at: new Date().toISOString() })));
  return recentFoods([...pending, ...(cache.recentItems || [])]);
}

// ── Write operations (queued) ─────────────────────────────────────────────
/** Removes queued ops matching pred, never the one currently being sent. */
function dropQueued(pred) {
  queue = queue.filter((op, i) => (flushing && i === 0) || !pred(op));
}

function enqueue(op) {
  queue.push({ ...op, qid: uuid(), attempts: 0 });
  LS.set(queueKey(), queue);
  state.pending = queue.length;
  emit('sync');
  flush();
}

const NUMERIC = ['quantity', 'grams', 'calories', 'protein', 'carbs', 'fat', 'fiber'];
function cleanItem(it) {
  const out = {
    id: it.id || uuid(),
    food_id: it.food_id || null,
    food_name: String(it.food_name || '').trim().slice(0, 200),
    source: it.source || 'manual',
    unit: String(it.unit || 'g').slice(0, 60),
  };
  for (const k of NUMERIC) out[k] = Math.max(0, Number(it[k]) || 0);
  if (!(out.quantity > 0)) out.quantity = 1;
  if (!out.food_name) throw new UserError('Food name is missing.');
  return out;
}

/** Logs items to a meal. Returns the stored items (with their client ids). */
export function logItems(date, mealType, items) {
  const clean = items.map(cleanItem);
  enqueue({ t: 'log', date, mealType, items: clean });
  updateCachedDay(date);
  if (!state.loggedDates.includes(date)) { state.loggedDates = [...state.loggedDates, date].sort(); emit('streak'); }
  emit('data-changed');
  return clean;
}

export function updateItem(item, mealType, patch) {
  const p = {};
  for (const k of [...NUMERIC, 'unit', 'food_name']) if (patch[k] !== undefined) p[k] = patch[k];
  enqueue({ t: 'updateItem', date: item.meal_date, id: item.id, mealType: mealType !== item.meal_type ? mealType : null, patch: p });
  updateCachedDay(item.meal_date);
  emit('data-changed');
}

export function deleteItem(item) {
  enqueue({ t: 'deleteItem', date: item.meal_date, id: item.id });
  updateCachedDay(item.meal_date, (d) => { d.items = d.items.filter((x) => x.id !== item.id); });
  emit('data-changed');
}

/** Sets the day's water to `ml` (0–20,000). Repeated taps collapse into one pending write. */
export function setWater(date, ml) {
  dropQueued((op) => op.t === 'water' && op.date === date);
  enqueue({ t: 'water', date, ml: Math.round(Math.max(0, Math.min(20000, Number(ml) || 0))) });
  updateCachedDay(date);
}

/** Adds (or with a negative amount removes) water for a day. Returns the new total in ml. */
export function addWater(date, deltaMl) {
  const current = date === state.date && state.day ? state.day.water : cachedDay(date)?.water || 0;
  const next = Math.max(0, Math.min(20000, (Number(current) || 0) + Number(deltaMl)));
  setWater(date, next);
  return next;
}

/** The user's weight on `date` (latest weigh-in on/before it), like public.weight_on(). */
export const weightOnDate = (date) => weightOn(date, state.weights, state.profile?.weight_kg);

/**
 * Calories an activity burned. MET-based entries are always recomputed from the weight on
 * the activity's date — exactly what the database stores — so a new weigh-in shows up at once.
 */
export function activityCalories(a) {
  if (a?.met == null) return Number(a?.calories_burned) || 0;
  const w = weightOnDate(a.activity_date);
  return w ? netActivityCalories(Number(a.met), w, Number(a.duration_min)) : Number(a.calories_burned) || 0;
}

/** Logs an activity. With a MET, calories come from the weight on that date (not rounded). */
export function logActivity(date, { name, duration_min, met = null, calories_burned = 0, source }) {
  const minutes = Math.min(1440, Math.max(0, Math.round(Number(duration_min)) || 0));
  const m = Number(met) >= 1 ? Math.min(25, r2(met)) : null;
  const row = { id: uuid(), activity_date: date, name: String(name).slice(0, 120), duration_min: minutes, met: m, calories_burned: 0, source };
  row.calories_burned = r2(m != null ? activityCalories(row) : Math.max(0, Number(calories_burned) || 0));
  enqueue({ t: 'activity', date, row });
  updateCachedDay(date);
  emit('data-changed');
  return row;
}

export function deleteActivity(act) {
  enqueue({ t: 'deleteActivity', date: act.activity_date, id: act.id });
  updateCachedDay(act.activity_date, (d) => { d.activities = d.activities.filter((x) => x.id !== act.id); });
  emit('data-changed');
}

/**
 * Logs a weigh-in (one per day — a second one on the same day replaces it). `details` sets the
 * source ('manual' | 'scale' | …), measurement time and heart rate; body composition is computed
 * from the profile unless `details.record` already carries it.
 */
export function logWeight(date, kg, details = {}) {
  const record = details.record || weighInRecord(kg, details);
  dropQueued((op) => (op.t === 'weight' || op.t === 'deleteWeight') && op.date === date);
  enqueue({ t: 'weight', date, kg: record.weight_kg, record });
  refreshLocalWeights();
  emit('data-changed');
  return record;
}

export function deleteWeight(date) {
  dropQueued((op) => op.t === 'weight' && op.date === date);
  enqueue({ t: 'deleteWeight', date });
  if (cache.weightsBase) cache.weightsBase = cache.weightsBase.filter((w) => w.recorded_on !== date);
  refreshLocalWeights();
}

// ── Sync engine ───────────────────────────────────────────────────────────
async function execute(op) {
  switch (op.t) {
    case 'log':
      return check(await sb.rpc('log_meal_items', { p_meal_date: op.date, p_meal_type: op.mealType, p_items: op.items }));
    case 'updateItem':
      return check(await sb.rpc('update_meal_item', { p_id: op.id, p_meal_type: op.mealType, p_patch: op.patch }));
    case 'deleteItem':
      return check(await sb.from('meal_items').delete().eq('id', op.id));
    case 'water':
      return check(await sb.from('water_logs').upsert({ user_id: uid, log_date: op.date, ml: op.ml ?? (op.glasses || 0) * 250 }, { onConflict: 'user_id,log_date' }));
    case 'favorite':
      return check(await sb.from('favorite_foods').upsert({ ...op.row, user_id: uid }, { onConflict: 'user_id,food_name,unit', ignoreDuplicates: true }));
    case 'unfavorite':
      return check(await sb.from('favorite_foods').delete().eq('food_name', op.food_name).eq('unit', op.unit));
    case 'activity':
      return check(await sb.from('activities').upsert({ ...op.row, user_id: uid }, { onConflict: 'id', ignoreDuplicates: true }));
    case 'deleteActivity':
      return check(await sb.from('activities').delete().eq('id', op.id));
    case 'weight':
      return check(await sb.from('weight_history').upsert({ ...(op.record || {}), user_id: uid, recorded_on: op.date, weight_kg: op.kg }, { onConflict: 'user_id,recorded_on' }));
    case 'deleteWeight':
      return check(await sb.from('weight_history').delete().eq('recorded_on', op.date));
    default:
      return null;
  }
}

function isTransient(e) {
  const msg = String(e?.message || '').toLowerCase();
  const status = Number(e?.status) || 0;
  return !navigator.onLine || status === 0 || status === 401 || status === 408 || status === 429 || status >= 500 ||
    msg.includes('fetch') || msg.includes('network') || msg.includes('jwt') || msg.includes('timeout');
}

const OP_LABEL = { log: 'a meal', updateItem: 'an edit', deleteItem: 'a deletion', water: 'water', activity: 'an activity', deleteActivity: 'a deletion', weight: 'a weigh-in', deleteWeight: 'a deletion', favorite: 'a favorite', unfavorite: 'a favorite' };

/** Changes the server rejected, newest last: [{ label, date, failedAt }]. */
export const failedChanges = () => failed.map((op) => ({ label: OP_LABEL[op.t] || 'a change', date: op.date, failedAt: op.failedAt }));

/** Puts rejected changes back in the queue and tries to send them again. */
export function retryFailed() {
  if (!failed.length) return;
  queue.push(...failed.map(({ failedAt, reason, ...op }) => ({ ...op, attempts: 0 })));
  failed = [];
  LS.set(failedKey(), failed); LS.set(queueKey(), queue);
  state.failed = 0; state.pending = queue.length;
  emit('sync');
  flush();
}

/** Forgets rejected changes (after the user confirms). */
export function discardFailed() {
  failed = [];
  LS.set(failedKey(), failed);
  state.failed = 0;
  emit('sync');
}

/** Sends queued operations in order. Safe to call any time. */
export async function flush() {
  if (flushing || !uid || !sb || !navigator.onLine || !queue.length) return;
  flushing = true;
  state.syncing = true; emit('sync');
  const touchedDates = new Set();
  let touchedWeights = false;
  let touchedFavorites = false;
  try {
    while (queue.length && uid) {
      const op = queue[0];
      try {
        await execute(op);
        queue.shift();
        touchedDates.add(op.date);
        if (op.t === 'weight' || op.t === 'deleteWeight') touchedWeights = true;
        if (op.t === 'favorite' || op.t === 'unfavorite') touchedFavorites = true;
        retryDelay = 2000;
      } catch (e) {
        if (isTransient(e) && op.attempts < 50) {
          op.attempts++;
          if (Number(e.status) === 401) await sb.auth.refreshSession().catch(() => {});
          clearTimeout(retryTimer);
          retryTimer = setTimeout(flush, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 60_000);
          console.warn('[NutriLog] sync will retry:', e.message);
          break;
        }
        // The server rejected it (e.g. invalid data). Move it aside so the queue can't get
        // stuck — but keep it, so the user can retry or discard it instead of losing it.
        console.error('[NutriLog] change rejected by the server', op, e);
        queue.shift();
        failed.push({ ...op, failedAt: new Date().toISOString(), reason: e.code || String(e.status || '') });
        LS.set(failedKey(), failed);
        state.failed = failed.length;
        touchedDates.add(op.date);
        emit('toast', { type: 'error', message: `Couldn't save ${OP_LABEL[op.t] || 'a change'}. You can retry it from the sync status.` });
      }
      LS.set(queueKey(), queue);
      state.pending = queue.length;
    }
  } finally {
    flushing = false;
    state.syncing = false;
    state.pending = queue.length;
    emit('sync');
  }
  // Reconcile with the server's copy of anything we just wrote.
  if (!queue.length) {
    if (touchedFavorites) fetchFavorites().catch(() => {});
    for (const d of touchedDates) if (d && cache.days[d]) fetchDay(d).then((day) => { if (d === state.date) { state.day = day; emit('day'); } }).catch(() => {});
    if (touchedWeights) {
      // The database updates the profile weight and recomputes activity calories.
      fetchWeights().catch(() => {});
      loadAccount().catch(() => {});
      if (state.date && !touchedDates.has(state.date) && cache.days[state.date]) {
        fetchDay(state.date).then((day) => { state.day = day; emit('day'); }).catch(() => {});
      }
    }
  }
}

// ── Automatic targets ─────────────────────────────────────────────────────
let targetsSync = null;
const near = (a, b, eps) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < eps;

/**
 * Keeps automatic (non-custom) targets in line with the profile, the latest weigh-in and the
 * goal date. Custom targets are never touched. Resolves to { before, after } when it changed
 * them, otherwise null.
 */
export function syncAutoTargets() {
  if (targetsSync) return targetsSync;
  targetsSync = (async () => {
    const g = state.goals;
    if (!uid || !g || g.is_custom || !state.profile?.onboarding_completed || !navigator.onLine) return null;
    const rec = recommendTargets(effectiveProfile(), { exerciseMode: state.prefs?.exercise_mode });
    if (!rec) return null;
    if (near(g.calories, rec.calories, 1) && near(g.protein_g, rec.protein, 0.06) && near(g.carbs_g, rec.carbs, 0.06)
      && near(g.fat_g, rec.fat, 0.06) && near(g.fiber_g, rec.fiber, 0.06)) return null;
    const before = { ...g };
    const after = await saveGoals({ ...rec, isCustom: false });
    return { before, after, rec };
  })().finally(() => { targetsSync = null; });
  return targetsSync;
}

// ── Export / legacy / realtime ────────────────────────────────────────────
export async function exportAll() {
  const [profile, prefs, goals, items, weights, activities, water, favorites] = await Promise.all([
    sb.from('profiles').select('*').maybeSingle().then(check),
    sb.from('user_preferences').select('*').maybeSingle().then(check),
    sb.from('daily_goals').select('*').maybeSingle().then(check),
    fetchAll(() => sb.from('meal_items').select('*').order('meal_date').order('created_at')),
    fetchAll(() => sb.from('weight_history').select('*').order('recorded_on')),
    fetchAll(() => sb.from('activities').select('*').order('activity_date')),
    fetchAll(() => sb.from('water_logs').select('*').order('log_date')),
    fetchAll(() => sb.from('favorite_foods').select('*').order('created_at')),
  ]);
  return {
    app: 'NutriLog', exported_at: new Date().toISOString(),
    account: { id: uid, email: state.user?.email },
    profile, preferences: prefs, daily_goals: goals,
    meal_items: items, weight_history: weights, activities, water_logs: water, favorite_foods: favorites,
  };
}

/**
 * One-time moves of data from the previous app version:
 *  - rows in the old tables owned by this auth user (anonymous "Secure Mode" upgrade)
 *  - weigh-ins that the old app kept only in this browser's localStorage
 */
export async function importLegacyData() {
  const flag = `nutrilog.legacyChecked.${uid}`;
  if (LS.get(flag)) return null;
  let imported = { meal_items: 0, weights: 0, activities: 0 };
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const { data, error } = await sb.rpc('claim_legacy_data', { p_tz: tz });
    if (!error && data) imported = data;
    else if (error && !/does not exist|schema cache|could not find/i.test(error.message)) throw error;
  } catch (e) {
    console.warn('[NutriLog] legacy import skipped:', e.message);
    return null;
  }
  const oldWeights = LS.get('weights');
  if (Array.isArray(oldWeights) && oldWeights.length) {
    const existing = new Set(state.weights.map((w) => w.recorded_on));
    for (const w of oldWeights) {
      const kg = Number(w.weight);
      if (/^\d{4}-\d{2}-\d{2}$/.test(w.date) && kg >= 20 && kg <= 400 && !existing.has(w.date)) {
        const record = weighInRecord(kg, { source: 'legacy' });
        enqueue({ t: 'weight', date: w.date, kg: record.weight_kg, record });
        imported.weights++;
      }
    }
    refreshLocalWeights();
    LS.del('weights');
  }
  LS.set(flag, true);
  return imported;
}

// ── Import (another NutriLog account's export, or a smart-scale backup) ────
const chunk = (list, n) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };

/**
 * Bulk-imports prepared records (see lib/import-formats.js) straight into the database.
 * Rows carry deterministic ids and use ON CONFLICT DO NOTHING, so importing the same file
 * twice changes nothing, and days that already have a weigh-in or water entry are kept.
 * `onProgress(done, total)` reports progress. Returns the number of rows sent per kind.
 */
export async function importRecords({ weights = [], items = [], activities = [], water = [], favorites = [] }, onProgress) {
  if (!uid || !sb) throw new UserError('Please log in again.');
  if (!navigator.onLine) throw new UserError('Importing needs an internet connection.');
  const total = weights.length + items.length + activities.length + water.length + favorites.length;
  let done = 0;
  const step = (n) => { done += n; onProgress?.(done, total); };

  for (const part of chunk(weights, 500)) {
    check(await sb.from('weight_history').upsert(part.map((w) => ({ ...w, user_id: uid })), { onConflict: 'user_id,recorded_on', ignoreDuplicates: true }));
    step(part.length);
  }
  if (items.length) {
    const meals = [...new Map(items.map((it) => [`${it.meal_date}|${it.meal_type}`, { user_id: uid, meal_date: it.meal_date, meal_type: it.meal_type }])).values()];
    for (const part of chunk(meals, 500)) {
      check(await sb.from('meals').upsert(part, { onConflict: 'user_id,meal_date,meal_type', ignoreDuplicates: true }));
    }
    const dates = items.map((it) => it.meal_date).sort();
    const rows = await fetchAll(() => sb.from('meals').select('id, meal_date, meal_type').gte('meal_date', dates[0]).lte('meal_date', dates[dates.length - 1]));
    const mealId = new Map(rows.map((m) => [`${m.meal_date}|${m.meal_type}`, m.id]));
    for (const part of chunk(items, 500)) {
      const payload = part.map(({ meal_date, meal_type, ...it }) => ({ ...it, user_id: uid, meal_id: mealId.get(`${meal_date}|${meal_type}`), meal_date, meal_type }));
      check(await sb.from('meal_items').upsert(payload.filter((it) => it.meal_id), { onConflict: 'id', ignoreDuplicates: true }));
      step(part.length);
    }
  }
  for (const part of chunk(activities, 500)) {
    check(await sb.from('activities').upsert(part.map((a) => ({ ...a, user_id: uid })), { onConflict: 'id', ignoreDuplicates: true }));
    step(part.length);
  }
  for (const part of chunk(water, 500)) {
    check(await sb.from('water_logs').upsert(part.map((w) => ({ ...w, user_id: uid })), { onConflict: 'user_id,log_date', ignoreDuplicates: true }));
    step(part.length);
  }
  for (const part of chunk(favorites, 500)) {
    check(await sb.from('favorite_foods').upsert(part.map((f) => ({ ...f, user_id: uid })), { onConflict: 'user_id,food_name,unit', ignoreDuplicates: true }));
    step(part.length);
  }
  // Show the imported data everywhere.
  cache.days = {}; cache.recentItems = null;
  saveCache();
  await Promise.allSettled([fetchWeights(), fetchLoggedDates(), fetchFavorites(), loadAccount()]);
  emit('remote-day', state.date);
  emit('data-changed');
  return { weights: weights.length, items: items.length, activities: activities.length, water: water.length, favorites: favorites.length };
}

/**
 * Permanently deletes everything the user has logged — meals, weigh-ins, activities, water and
 * favorites — on every device. The account, profile and targets stay. RLS limits each delete
 * to the user's own rows.
 */
export async function deleteMyData() {
  if (!uid || !sb) throw new UserError('Please log in again.');
  if (!navigator.onLine) throw new UserError('Deleting your data needs an internet connection.');
  // Pending changes would re-create data after the delete, so drop them first.
  queue = []; failed = [];
  LS.set(queueKey(), queue); LS.set(failedKey(), failed);
  state.pending = 0; state.failed = 0;
  for (const table of ['meal_items', 'meals', 'activities', 'water_logs', 'favorite_foods', 'weight_history']) {
    check(await sb.from(table).delete().eq('user_id', uid));
  }
  cache.days = {}; cache.recentItems = []; cache.weightsBase = []; cache.favoritesBase = [];
  saveCache();
  await Promise.allSettled([fetchWeights(), fetchLoggedDates(), fetchFavorites(), loadAccount()]);
  emit('sync');
  emit('remote-day', state.date);
  emit('data-changed');
}

let channel = null;
/** Live updates from other devices. RLS limits events to the user's own rows. */
export function subscribeRealtime(onChange) {
  unsubscribeRealtime();
  const tables = ['meal_items', 'activities', 'water_logs', 'weight_history', 'daily_goals', 'user_preferences', 'favorite_foods'];
  channel = sb.channel(`user-${uid}`);
  for (const table of tables) {
    channel.on('postgres_changes', { event: '*', schema: 'public', table, filter: `user_id=eq.${uid}` }, (p) => onChange(table, p));
  }
  channel.on('postgres_changes', { event: '*', schema: 'public', table: 'profiles', filter: `id=eq.${uid}` }, (p) => onChange('profiles', p));
  channel.subscribe((status) => { if (status === 'CHANNEL_ERROR') console.warn('[NutriLog] realtime unavailable; using refresh-on-focus'); });
}

export function unsubscribeRealtime() {
  if (channel) { sb.removeChannel(channel); channel = null; }
}

export const hasPendingFor = (date) => queue.some((op) => op.date === date);
export { friendlyError, today, addDays };
