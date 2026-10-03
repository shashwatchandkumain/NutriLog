// Global app state + a tiny event bus. Views read `state` and re-render on events.
import { today } from './lib/utils.js';

export const APP_VERSION = '2.3.0';

export const state = {
  isAdmin: false,       // may review the shared Global Food Database (checked again by the server)
  session: null,
  user: null,
  profile: null,
  prefs: null,
  goals: null,
  date: today(),
  day: null,            // { items, activities, water }
  weights: [],          // [{ recorded_on, weight_kg, source, body_fat_pct, … }] ascending
  loggedDates: [],      // ['YYYY-MM-DD', ...]
  favorites: [],        // the user's saved foods
  online: navigator.onLine,
  pending: 0,           // queued offline writes
  failed: 0,            // writes the server rejected, kept for retry
  syncing: false,
  passwordRecovery: false,
};

const listeners = new Map();

/** Subscribe to an event. Returns an unsubscribe function. */
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}

export function emit(event, detail) {
  for (const fn of listeners.get(event) || []) {
    try { fn(detail); } catch (e) { console.error(`[NutriLog] listener for ${event} failed`, e); }
  }
}

/** Effective daily targets, with safe defaults before onboarding sets real ones. */
export function currentGoals() {
  const g = state.goals || {};
  return {
    calories: Number(g.calories) || 2000,
    protein: Number(g.protein_g) || 100,
    carbs: Number(g.carbs_g) || 250,
    fat: Number(g.fat_g) || 65,
    fiber: Number(g.fiber_g) || 28,
    isCustom: !!g.is_custom,
    isSet: !!g.calories,
  };
}

/** The profile with its weight replaced by the latest weigh-in (including unsynced ones). */
export function effectiveProfile() {
  const p = state.profile || {};
  const latest = state.weights?.length ? Number(state.weights[state.weights.length - 1].weight_kg) : null;
  return latest > 0 ? { ...p, weight_kg: latest } : p;
}

export const weightUnit = () => state.prefs?.weight_unit || 'kg';
/** Daily water goal in ml. */
export const waterGoalMl = () => Number(state.prefs?.water_goal_ml) || (Number(state.prefs?.water_goal) || 8) * 250;
export const aiProvider = () => (state.prefs?.ai_provider === 'claude' ? 'claude' : 'gemini');
export const heightUnit = () => state.prefs?.height_unit || 'cm';
