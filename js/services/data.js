// Data layer: reads from Supabase, caches locally for instant/offline display, and sends
// writes through a persistent queue so nothing is lost offline and retries never duplicate.
//
// Writes are optimistic: the local view updates immediately, the queued operation is sent
// when online. Every operation is idempotent on the server (client-generated ids, upserts,
// ON CONFLICT DO NOTHING), so a retry after a lost response can't create duplicates.
import { sb } from './supabase.js';
import { state, emit } from '../store.js';
import { uuid, today, addDays, UserError, friendlyError } from '../lib/utils.js';

let uid = null;
let queue = [];
let flushing = false;
let retryTimer = null;
let retryDelay = 2000;
let cache = { days: {} };

const LS = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota or blocked */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const queueKey = () => `nutrilog.queue.${uid}`;
const cacheKey = () => `nutrilog.cache.${uid}`;
const MAX_CACHED_DAYS = 21;

// ── Session lifecycle ─────────────────────────────────────────────────────
export function startDataSession(userId) {
  uid = userId;
  queue = LS.get(queueKey()) || [];
  cache = LS.get(cacheKey()) || { days: {} };
  cache.days ||= {};
  state.pending = queue.length;
  if (cache.profile) state.profile = cache.profile;
  if (cache.prefs) state.prefs = cache.prefs;
  if (cache.goals) state.goals = cache.goals;
  if (cache.weights) state.weights = cache.weights;
  if (cache.loggedDates) state.loggedDates = cache.loggedDates;
  flush();
}

/** Clears everything cached for the user on this device (logout / account deletion). */
export function endDataSession({ keepQueue = false } = {}) {
  if (uid) {
    LS.del(cacheKey());
    if (!keepQueue) LS.del(queueKey());
  }
  uid = null; queue = []; cache = { days: {} };
  clearTimeout(retryTimer);
  state.pending = 0;
}

let saveTimer;
function saveCache() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!uid) return;
    const dates = Object.keys(cache.days).sort().reverse();
    for (const d of dates.slice(MAX_CACHED_DAYS)) delete cache.days[d];
    LS.set(cacheKey(), cache);
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
      case 'water': d.water = op.glasses; break;
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
    sb.from('water_logs').select('glasses').eq('log_date', date).maybeSingle(),
  ]);
  const day = { items: check(items), activities: check(acts), water: check(water)?.glasses ?? 0 };
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
    if (op.date < start || op.date > end) continue;
    if (op.t === 'log') for (const it of op.items) byId.set(it.id, { ...it, meal_date: op.date });
    if (op.t === 'deleteItem') byId.delete(op.id);
    if (op.t === 'updateItem' && byId.has(op.id)) byId.set(op.id, { ...byId.get(op.id), ...op.patch });
  }
  return [...byId.values()];
}

export async function fetchActivitiesRange(start, end) {
  return fetchAll(() => sb.from('activities').select('id, activity_date, calories_burned')
    .gte('activity_date', start).lte('activity_date', end));
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
function overlayWeights(rows) {
  const map = new Map(rows.map((w) => [w.recorded_on, { recorded_on: w.recorded_on, weight_kg: Number(w.weight_kg) }]));
  for (const op of queue) {
    if (op.t === 'weight') map.set(op.date, { recorded_on: op.date, weight_kg: op.kg, pending: true });
    if (op.t === 'deleteWeight') map.delete(op.date);
  }
  return [...map.values()].sort((a, b) => a.recorded_on.localeCompare(b.recorded_on));
}

export async function fetchWeights() {
  const rows = await fetchAll(() => sb.from('weight_history').select('recorded_on, weight_kg').order('recorded_on'));
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
  for (const k of [...NUMERIC, 'unit']) if (patch[k] !== undefined) p[k] = patch[k];
  enqueue({ t: 'updateItem', date: item.meal_date, id: item.id, mealType: mealType !== item.meal_type ? mealType : null, patch: p });
  updateCachedDay(item.meal_date);
  emit('data-changed');
}

export function deleteItem(item) {
  enqueue({ t: 'deleteItem', date: item.meal_date, id: item.id });
  updateCachedDay(item.meal_date, (d) => { d.items = d.items.filter((x) => x.id !== item.id); });
  emit('data-changed');
}

export function setWater(date, glasses) {
  // Collapse repeated taps into one pending write for the day.
  dropQueued((op) => op.t === 'water' && op.date === date);
  enqueue({ t: 'water', date, glasses: Math.max(0, Math.min(40, glasses)) });
  updateCachedDay(date);
}

export function logActivity(date, { name, duration_min, calories_burned, source }) {
  const row = { id: uuid(), activity_date: date, name: String(name).slice(0, 120), duration_min: Math.round(duration_min) || 0, calories_burned: Math.round(calories_burned) || 0, source };
  enqueue({ t: 'activity', date, row });
  updateCachedDay(date);
  emit('data-changed');
}

export function deleteActivity(act) {
  enqueue({ t: 'deleteActivity', date: act.activity_date, id: act.id });
  updateCachedDay(act.activity_date, (d) => { d.activities = d.activities.filter((x) => x.id !== act.id); });
  emit('data-changed');
}

export function logWeight(date, kg) {
  dropQueued((op) => (op.t === 'weight' || op.t === 'deleteWeight') && op.date === date);
  enqueue({ t: 'weight', date, kg: Math.round(kg * 10) / 10 });
  refreshLocalWeights();
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
      return check(await sb.from('water_logs').upsert({ user_id: uid, log_date: op.date, glasses: op.glasses }, { onConflict: 'user_id,log_date' }));
    case 'activity':
      return check(await sb.from('activities').upsert({ ...op.row, user_id: uid }, { onConflict: 'id', ignoreDuplicates: true }));
    case 'deleteActivity':
      return check(await sb.from('activities').delete().eq('id', op.id));
    case 'weight':
      return check(await sb.from('weight_history').upsert({ user_id: uid, recorded_on: op.date, weight_kg: op.kg }, { onConflict: 'user_id,recorded_on' }));
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

const OP_LABEL = { log: 'a meal', updateItem: 'an edit', deleteItem: 'a deletion', water: 'water', activity: 'an activity', deleteActivity: 'a deletion', weight: 'a weigh-in', deleteWeight: 'a deletion' };

/** Sends queued operations in order. Safe to call any time. */
export async function flush() {
  if (flushing || !uid || !sb || !navigator.onLine || !queue.length) return;
  flushing = true;
  state.syncing = true; emit('sync');
  const touchedDates = new Set();
  let touchedWeights = false;
  try {
    while (queue.length && uid) {
      const op = queue[0];
      try {
        await execute(op);
        queue.shift();
        touchedDates.add(op.date);
        if (op.t === 'weight' || op.t === 'deleteWeight') touchedWeights = true;
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
        // Permanent failure (e.g. invalid data): drop it so the queue can't get stuck.
        console.error('[NutriLog] dropping unsyncable change', op, e);
        queue.shift();
        touchedDates.add(op.date);
        emit('toast', { type: 'error', message: `Couldn't save ${OP_LABEL[op.t] || 'a change'}. Please try again.` });
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
    for (const d of touchedDates) if (d && cache.days[d]) fetchDay(d).then((day) => { if (d === state.date) { state.day = day; emit('day'); } }).catch(() => {});
    if (touchedWeights) fetchWeights().catch(() => {});
  }
}

// ── Export / legacy / realtime ────────────────────────────────────────────
export async function exportAll() {
  const [profile, prefs, goals, items, weights, activities, water] = await Promise.all([
    sb.from('profiles').select('*').maybeSingle().then(check),
    sb.from('user_preferences').select('*').maybeSingle().then(check),
    sb.from('daily_goals').select('*').maybeSingle().then(check),
    fetchAll(() => sb.from('meal_items').select('*').order('meal_date').order('created_at')),
    fetchAll(() => sb.from('weight_history').select('*').order('recorded_on')),
    fetchAll(() => sb.from('activities').select('*').order('activity_date')),
    fetchAll(() => sb.from('water_logs').select('*').order('log_date')),
  ]);
  return {
    app: 'NutriLog', exported_at: new Date().toISOString(),
    account: { id: uid, email: state.user?.email },
    profile, preferences: prefs, daily_goals: goals,
    meal_items: items, weight_history: weights, activities, water_logs: water,
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
        enqueue({ t: 'weight', date: w.date, kg: Math.round(kg * 10) / 10 });
        imported.weights++;
      }
    }
    refreshLocalWeights();
    LS.del('weights');
  }
  LS.set(flag, true);
  return imported;
}

let channel = null;
/** Live updates from other devices. RLS limits events to the user's own rows. */
export function subscribeRealtime(onChange) {
  unsubscribeRealtime();
  const tables = ['meal_items', 'activities', 'water_logs', 'weight_history', 'daily_goals', 'user_preferences'];
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
