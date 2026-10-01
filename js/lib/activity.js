// Exercise energy from MET values (Compendium of Physical Activities, 2024 update) and the
// ACSM metabolic equations for treadmill walking/running.
// NutriLog uses NET calories — (MET − 1) × kg × hours — because resting energy is already
// counted in BMR/TDEE. Counting gross MET would double-count ~1 kcal/kg/hour.
// The weight is the user's weight ON THE ACTIVITY'S DATE (see weightOn), exactly as the
// database computes it, and nothing is rounded except for display.

export const ACTIVITY_PRESETS = [
  { id: 'treadmill', name: 'Treadmill', emoji: '🏃‍♂️', treadmill: true },
  { id: 'walking', name: 'Walking', emoji: '🚶', met: 3.5 },
  { id: 'brisk-walk', name: 'Brisk walking', emoji: '🚶‍♀️', met: 4.3 },
  { id: 'running', name: 'Running', emoji: '🏃', met: 9.8 },
  { id: 'cycling', name: 'Cycling', emoji: '🚴', met: 7.5 },
  { id: 'gym', name: 'Weight training', emoji: '🏋️', met: 5.0 },
  { id: 'hiit', name: 'HIIT', emoji: '⚡', met: 8.0 },
  { id: 'yoga', name: 'Yoga', emoji: '🧘', met: 2.5 },
  { id: 'swimming', name: 'Swimming', emoji: '🏊', met: 7.0 },
  { id: 'badminton', name: 'Badminton', emoji: '🏸', met: 5.5 },
  { id: 'cricket', name: 'Cricket', emoji: '🏏', met: 4.8 },
  { id: 'football', name: 'Football', emoji: '⚽', met: 7.0 },
  { id: 'dancing', name: 'Dancing', emoji: '💃', met: 5.0 },
  { id: 'stairs', name: 'Stair climbing', emoji: '🪜', met: 8.0 },
  { id: 'housework', name: 'Housework', emoji: '🧹', met: 3.3 },
];

/** Net kcal burned above resting for `minutes` of an activity with `met`, for `weightKg`. */
export function netActivityCalories(met, weightKg, minutes) {
  const m = Number(met), w = Number(weightKg), t = Number(minutes);
  if (!(m > 0 && w > 0 && t > 0)) return 0;
  return Math.max(0, m - 1) * w * (t / 60);
}

/** Below this speed the ACSM walking equation applies; at or above it, the running one. */
export const TREADMILL_RUN_KMH = 7;

/**
 * MET for treadmill exercise from speed (km/h) and incline (%), using the ACSM equations:
 *   walking: VO₂ = 3.5 + 0.1·S + 1.8·S·G
 *   running: VO₂ = 3.5 + 0.2·S + 0.9·S·G      (S in m/min, G = grade as a fraction)
 *   MET = VO₂ / 3.5
 * `mode` 'walk' | 'run' overrides the speed-based choice (brisk walkers vs slow joggers).
 */
export function treadmillMet({ speedKmh, inclinePct = 0, mode } = {}) {
  const kmh = Number(speedKmh);
  if (!(kmh > 0 && kmh <= 30)) return null;
  const s = (kmh * 1000) / 60;
  const g = Math.min(40, Math.max(0, Number(inclinePct) || 0)) / 100;
  const run = mode ? mode === 'run' : kmh >= TREADMILL_RUN_KMH;
  const vo2 = run ? 3.5 + 0.2 * s + 0.9 * s * g : 3.5 + 0.1 * s + 1.8 * s * g;
  return vo2 / 3.5;
}

/**
 * The user's weight (kg) on `date`: the latest weigh-in on or before it, else the earliest
 * weigh-in, else `fallbackKg`. Mirrors public.weight_on() in the database.
 * `weights` is [{ recorded_on, weight_kg }] sorted ascending.
 */
export function weightOn(date, weights, fallbackKg = null) {
  const list = weights || [];
  let found = null;
  for (const w of list) {
    if (w.recorded_on <= date) found = w;
    else break;
  }
  const v = Number((found || list[0])?.weight_kg);
  if (v > 0) return v;
  const f = Number(fallbackKg);
  return f > 0 ? f : null;
}
