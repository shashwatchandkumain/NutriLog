// Exercise energy from MET values (Compendium of Physical Activities, 2024 update).
// NutriLog uses NET calories — (MET − 1) × kg × hours — because resting energy is
// already counted in BMR/TDEE. Counting gross MET would double-count ~1 kcal/kg/hour.

export const ACTIVITY_PRESETS = [
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
