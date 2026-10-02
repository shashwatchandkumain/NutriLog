// Pure statistics over logged data: streaks, daily totals, averages, weight progress.
import { addDays, today as todayIso } from './utils.js';
import { sumNutrition } from './nutrition.js';

/** Groups items ({ meal_date, calories, ... }) into per-day totals. */
export function totalsByDate(items) {
  const byDay = new Map();
  for (const it of items || []) {
    if (!byDay.has(it.meal_date)) byDay.set(it.meal_date, []);
    byDay.get(it.meal_date).push(it);
  }
  const out = {};
  for (const [d, list] of byDay) out[d] = { ...sumNutrition(list), count: list.length };
  return out;
}

/**
 * Logging streak from a set of dates that have at least one item.
 * The current streak stays alive if today isn't logged yet but yesterday was.
 */
export function computeStreak(dates, today = todayIso()) {
  const set = new Set(dates);
  let current = 0;
  let cursor = set.has(today) ? today : addDays(today, -1);
  while (set.has(cursor)) { current++; cursor = addDays(cursor, -1); }

  const sorted = [...set].sort();
  let best = 0, run = 0, prev = null;
  for (const d of sorted) {
    run = prev && addDays(prev, 1) === d ? run + 1 : 1;
    if (run > best) best = run;
    prev = d;
  }
  return { current, best: Math.max(best, current), daysLogged: set.size };
}

/** Averages over days that actually have data. Returns null if there are none. */
export function averageOfLoggedDays(dailyTotals, dates) {
  const days = dates.filter((d) => dailyTotals[d] && dailyTotals[d].count > 0);
  if (!days.length) return null;
  const s = sumNutrition(days.map((d) => dailyTotals[d]));
  const n = days.length;
  return { days: n, calories: s.calories / n, protein: s.protein / n, carbs: s.carbs / n, fat: s.fat / n, fiber: s.fiber / n };
}

/**
 * Daily score 0–100 (kept from the original app): calories near target (35),
 * protein ≥80% (25), fiber ≥80% (20), eating pattern of 3+ items (20).
 */
export function dailyScore(totals, goals, itemCount) {
  if (!itemCount) return null;
  let score = 0;
  const factors = [];
  const calR = goals.calories > 0 ? totals.calories / goals.calories : 0;
  const calOk = calR >= 0.85 && calR <= 1.1;
  score += calOk ? 35 : calR >= 0.65 && calR <= 1.2 ? 18 : calR > 0 ? 6 : 0;
  factors.push({ label: 'Calories', ok: calOk });
  const protR = goals.protein > 0 ? totals.protein / goals.protein : 0;
  score += protR >= 0.8 ? 25 : protR >= 0.5 ? 12 : protR > 0 ? 4 : 0;
  factors.push({ label: 'Protein', ok: protR >= 0.8 });
  const fibR = goals.fiber > 0 ? totals.fiber / goals.fiber : 0;
  score += fibR >= 0.8 ? 20 : fibR >= 0.5 ? 10 : fibR > 0 ? 3 : 0;
  factors.push({ label: 'Fiber', ok: fibR >= 0.8 });
  const varOk = itemCount >= 3;
  score += varOk ? 20 : itemCount >= 2 ? 12 : 6;
  factors.push({ label: varOk ? '3+ items' : `${itemCount} item${itemCount === 1 ? '' : 's'}`, ok: varOk });
  score = Math.min(100, Math.round(score));
  const grade = score >= 85 ? 'Excellent day' : score >= 70 ? 'Good progress' : score >= 50 ? 'Keep going' : 'Just getting started';
  return { score, grade, factors };
}

/** Weight entries sorted ascending by date: [{ recorded_on, weight_kg }]. */
export function sortWeights(weights) {
  return [...(weights || [])].sort((a, b) => a.recorded_on.localeCompare(b.recorded_on));
}

/** Change between the latest entry and the latest entry on/before `days` ago. */
export function weightChange(weights, days, today = todayIso()) {
  const w = sortWeights(weights);
  if (w.length < 2) return null;
  const latest = w[w.length - 1];
  const cutoff = addDays(today, -days);
  const earlier = [...w].reverse().find((x) => x.recorded_on <= cutoff) || w[0];
  if (earlier === latest) return null;
  return { from: earlier, to: latest, change: Number(latest.weight_kg) - Number(earlier.weight_kg) };
}

/** Progress from starting weight toward target weight, 0–1 (null if not meaningful). */
export function goalProgress(startKg, currentKg, targetKg) {
  const s = Number(startKg), c = Number(currentKg), t = Number(targetKg);
  if (![s, c, t].every(Number.isFinite) || s === t) return null;
  const p = (s - c) / (s - t);
  return Math.max(0, Math.min(1, p));
}

/**
 * Trailing average weight for each weigh-in: the mean of entries in the `days` days ending on
 * that date. Smooths day-to-day water swings so the trend is easier to read.
 */
export function movingAverage(weights, days = 7) {
  const w = sortWeights(weights);
  return w.map((x) => {
    const from = addDays(x.recorded_on, -(days - 1));
    const win = w.filter((y) => y.recorded_on >= from && y.recorded_on <= x.recorded_on);
    return { recorded_on: x.recorded_on, value: win.reduce((s, y) => s + Number(y.weight_kg), 0) / win.length };
  });
}

const dayNumber = (iso) => Math.round(Date.parse(`${iso}T12:00:00Z`) / 86400000);

/**
 * Weight trend in kg per week: the least-squares slope through the weigh-ins between `start`
 * and `end`. Needs at least 3 weigh-ins spread over 7+ days, so a single day's swing can't
 * read as a trend; returns null otherwise.
 */
export function weightTrend(weights, start, end = todayIso()) {
  const pts = sortWeights(weights).filter((x) => x.recorded_on >= start && x.recorded_on <= end);
  if (pts.length < 3) return null;
  const xs = pts.map((p) => dayNumber(p.recorded_on));
  if (xs[xs.length - 1] - xs[0] < 7) return null;
  const ys = pts.map((p) => Number(p.weight_kg));
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den ? (num / den) * 7 : null;
}
