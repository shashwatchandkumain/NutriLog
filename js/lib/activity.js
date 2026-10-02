// Exercise energy from MET values (Compendium of Physical Activities, 2024 update) and the
// ACSM metabolic equations for treadmill walking/running.
// NutriLog uses NET calories — (MET − 1) × kg × hours — because resting energy is already
// counted in BMR/TDEE. Counting gross MET would double-count ~1 kcal/kg/hour.
// The weight is the user's weight ON THE ACTIVITY'S DATE (see weightOn), exactly as the
// database computes it, and nothing is rounded except for display.

// `intensities` (light / moderate / vigorous) are Compendium values for the same activity at
// different paces; "moderate" is always the preset's default MET.
export const ACTIVITY_PRESETS = [
  { id: 'treadmill', name: 'Treadmill', emoji: '🏃‍♂️', treadmill: true },
  { id: 'walking', name: 'Walking', emoji: '🚶', met: 3.5, intensities: { light: 2.8, moderate: 3.5, vigorous: 4.3 } }, // 2.0 / 3.0 / 3.5 mph
  { id: 'running', name: 'Running', emoji: '🏃', met: 9.8, intensities: { light: 8.3, moderate: 9.8, vigorous: 11.0 } }, // 5 / 6 / 7 mph
  { id: 'cycling', name: 'Cycling', emoji: '🚴', met: 7.5, intensities: { light: 4.0, moderate: 7.5, vigorous: 10.0 } }, // leisure / general / 14–16 mph
  { id: 'gym', name: 'Weight training', emoji: '🏋️', met: 5.0, intensities: { light: 3.5, moderate: 5.0, vigorous: 6.0 } },
  { id: 'hiit', name: 'HIIT', emoji: '⚡', met: 8.0 },
  { id: 'yoga', name: 'Yoga', emoji: '🧘', met: 2.5, intensities: { moderate: 2.5, vigorous: 4.0 } }, // hatha / power
  { id: 'swimming', name: 'Swimming', emoji: '🏊', met: 7.0, intensities: { light: 5.8, moderate: 7.0, vigorous: 9.8 } },
  { id: 'badminton', name: 'Badminton', emoji: '🏸', met: 5.5 },
  { id: 'cricket', name: 'Cricket', emoji: '🏏', met: 4.8 },
  { id: 'football', name: 'Football', emoji: '⚽', met: 7.0 },
  { id: 'dancing', name: 'Dancing', emoji: '💃', met: 5.0 },
  { id: 'stairs', name: 'Stair climbing', emoji: '🪜', met: 8.0 },
  { id: 'housework', name: 'Housework', emoji: '🧹', met: 3.3 },
];

export const INTENSITY_LABEL = { light: 'Light', moderate: 'Moderate', vigorous: 'Vigorous' };

/** MET for a preset at an intensity (moderate = the preset's default). */
export function presetMet(preset, intensity = 'moderate') {
  return preset?.intensities?.[intensity] ?? preset?.met ?? null;
}

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
