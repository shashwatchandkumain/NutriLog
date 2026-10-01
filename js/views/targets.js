// Shows how targets are derived (BMR → TDEE → goal plan → macros) and edits custom ones.
import { html, fmtInt, fmtNum, formatDay } from '../lib/utils.js';
import { ACTIVITY_LEVELS, GOALS, macroCalories, formatWeight } from '../lib/nutrition.js';

const macroRow = (label, color, grams, note) => html`
  <div class="target"><div class="l"><i class="dot" style="background:var(${color})"></i>${label}</div><div class="v">${fmtNum(grams, 1)} g</div><div class="tiny muted">${note}</div></div>`;

const signed = (v, digits = 1) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${fmtNum(Math.abs(v), digits)}`;
const day = (iso) => formatDay(iso, { day: 'numeric', month: 'short', year: 'numeric' });

/** One sentence describing the goal plan (target date, pace, safety caps). */
export function planSummary(plan, p, unit = 'kg') {
  if (!plan) return '';
  const target = formatWeight(p.target_weight_kg, unit);
  switch (plan.status) {
    case 'reached':
      return Math.abs(plan.changeKg) < 0.05
        ? `You're at your target of ${target} — your calories are set to maintenance. Update your goal or target to keep going.`
        : `Your target (${target}) is ${plan.changeKg > 0 ? 'above' : 'below'} your current weight, so there is nothing left to ${p.goal === 'lose' ? 'lose' : 'gain'} — your calories are set to maintenance. Check your goal and target weight.`;
    case 'dated': return `To reach ${target} by ${day(p.target_date)} (${plan.days} days), eat ${fmtNum(Math.abs(plan.plannedDaily), 1)} kcal a day ${plan.plannedDaily < 0 ? 'below' : 'above'} your TDEE — about ${fmtNum(Math.abs(plan.plannedWeeklyKg), 2)} kg a week.`;
    case 'capped': return `Reaching ${target} by ${day(p.target_date)} would need ${fmtNum(Math.abs(plan.requiredWeeklyKg), 2)} kg a week, faster than is safe. NutriLog uses the safe pace (${fmtNum(Math.abs(plan.plannedWeeklyKg), 2)} kg a week)${plan.projectedDate ? `, which reaches it around ${day(plan.projectedDate)}` : ''}.`;
    case 'past': return `Your target date (${day(p.target_date)}) has passed. Using the standard pace for now — set a new date to plan your calories.`;
    default: return `At ${fmtNum(Math.abs(plan.plannedWeeklyKg), 2)} kg a week you'd reach ${target}${plan.projectedDate ? ` around ${day(plan.projectedDate)}` : ''}. Add a target date to plan it exactly.`;
  }
}

/** t = targets to show, rec = recommendation (bmr, tdee, plan, …), p = profile. */
export function targetsView(t, rec, p, unit = 'kg') {
  if (!rec) return html`<div class="form-note">Add your age, height and weight to get a personalised recommendation.</div>`;
  const level = ACTIVITY_LEVELS[p.activity_level] || ACTIVITY_LEVELS.sedentary;
  const adj = rec.calories - rec.tdee;
  const kcal = macroCalories(t);
  const goalLabel = rec.plan?.status === 'reached' ? 'Target reached · maintenance'
    : rec.plan && ['dated', 'capped'].includes(rec.plan.status) ? `${(GOALS[p.goal] || GOALS.maintain).label} by ${day(p.target_date)}`
      : (GOALS[p.goal] || GOALS.maintain).label;
  return html`
    <div class="card" style="padding:16px">
      <dl class="kv calc">
        <dt>BMR <span class="faint">(Mifflin–St Jeor, ${formatWeight(p.weight_kg, unit)})</span></dt><dd>${fmtNum(rec.bmr, 1)} kcal</dd>
        <dt>× ${level.label} (${level.multiplier})</dt><dd>TDEE ${fmtNum(rec.tdee, 1)} kcal</dd>
        <dt>${goalLabel}</dt><dd>${signed(adj)} kcal</dd>
      </dl>
    </div>
    ${rec.plan ? html`<div class="form-note">${planSummary(rec.plan, p, unit)}</div>` : ''}
    <div class="targets">
      <div class="target primary"><div class="l">Daily calorie target${t.calories !== rec.calories ? ' (custom)' : ''}</div><div class="v">${fmtInt(t.calories)} kcal</div></div>
      ${macroRow('Protein', '--c-protein', t.protein, `${fmtInt(t.protein * 4)} kcal`)}
      ${macroRow('Carbs', '--c-carbs', t.carbs, `${fmtInt(t.carbs * 4)} kcal`)}
      ${macroRow('Fat', '--c-fat', t.fat, `${fmtInt(t.fat * 9)} kcal`)}
      ${macroRow('Fiber', '--c-fiber', t.fiber, '14 g per 1,000 kcal')}
    </div>
    ${Math.abs(kcal - t.calories) > Math.max(50, t.calories * 0.05) ? html`<p class="tag warn">Your macros add up to ${fmtInt(kcal)} kcal, not ${fmtInt(t.calories)}.</p>` : ''}
    <p class="explain">BMR is the energy your body uses at rest; TDEE multiplies it by your activity level. ${p.goal === 'lose' ? 'Losing weight: with a target date the deficit is planned to reach your target on that day (7,700 kcal ≈ 1 kg), capped at 1% of body weight a week and never below a safe minimum; without a date NutriLog subtracts up to 500 kcal.' : p.goal === 'gain' ? 'Gaining weight: with a target date the surplus is planned for that day (up to 0.5 kg a week); without one NutriLog adds 10% (250–500 kcal).' : p.goal === 'muscle' ? 'Building muscle: a small surplus (up to 0.25 kg a week with a target date, otherwise +5%) and higher protein.' : ''} Targets follow your latest weigh-in automatically unless you set custom ones. Protein is set per kg of body weight for your goal; fat is a share of calories; carbs fill the rest.</p>`;
}

export function customTargetsForm(t) {
  const f = (name, label, v, unit, step) => html`<div class="field"><label for="ct-${name}">${label}</label>
    <div class="input-group"><input class="input" id="ct-${name}" name="${name}" type="number" inputmode="decimal" min="0" step="${step}" value="${step === '1' ? Math.round(v) : Math.round(v * 10) / 10}"><span class="input-suffix">${unit}</span></div></div>`;
  return html`
    ${f('calories', 'Calories', t.calories, 'kcal', '1')}
    <div class="grid-2">${f('protein', 'Protein', t.protein, 'g', '0.1')}${f('carbs', 'Carbs', t.carbs, 'g', '0.1')}${f('fat', 'Fat', t.fat, 'g', '0.1')}${f('fiber', 'Fiber', t.fiber, 'g', '0.1')}</div>`;
}

export function readCustomTargets(form) {
  const v = Object.fromEntries(['calories', 'protein', 'carbs', 'fat', 'fiber'].map((k) => [k, Number(form.elements.namedItem(k)?.value)]));
  if (!(v.calories >= 800 && v.calories <= 10000)) return { error: 'Calories must be between 800 and 10,000.' };
  const max = { protein: 600, carbs: 1500, fat: 600, fiber: 150 };
  for (const k of ['protein', 'carbs', 'fat', 'fiber']) if (!(v[k] >= 0 && v[k] <= max[k])) return { error: `Enter a valid ${k} target (0–${max[k]} g).` };
  v.calories = Math.round(v.calories);
  for (const k of ['protein', 'carbs', 'fat', 'fiber']) v[k] = Math.round(v[k] * 10) / 10;
  return { targets: v };
}
