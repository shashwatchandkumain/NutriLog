// Shows how targets are derived (BMR → TDEE → goal adjustment → macros) and edits custom ones.
import { html, fmtInt } from '../lib/utils.js';
import { ACTIVITY_LEVELS, GOALS, macroCalories } from '../lib/nutrition.js';

const macroRow = (label, color, grams, note) => html`
  <div class="target"><div class="l"><i class="dot" style="background:var(${color})"></i>${label}</div><div class="v">${fmtInt(grams)} g</div><div class="tiny muted">${note}</div></div>`;

/** t = targets to show, rec = recommendation (bmr, tdee, …), p = profile. */
export function targetsView(t, rec, p) {
  if (!rec) return html`<div class="form-note">Add your age, height and weight to get a personalised recommendation.</div>`;
  const level = ACTIVITY_LEVELS[p.activity_level] || ACTIVITY_LEVELS.sedentary;
  const adj = rec.calories - rec.tdee;
  const kcal = macroCalories(t);
  return html`
    <div class="card" style="padding:16px">
      <dl class="kv">
        <dt>BMR <span class="faint">(Mifflin–St Jeor)</span></dt><dd>${fmtInt(rec.bmr)} kcal</dd>
        <dt>× ${level.label} (${level.multiplier})</dt><dd>TDEE ${fmtInt(rec.tdee)} kcal</dd>
        <dt>${(GOALS[p.goal] || GOALS.maintain).label}</dt><dd>${adj === 0 ? '±0' : `${adj > 0 ? '+' : '−'}${fmtInt(Math.abs(adj))}`} kcal</dd>
      </dl>
    </div>
    <div class="targets">
      <div class="target primary"><div class="l">Daily calorie target${t.calories !== rec.calories ? ' (custom)' : ''}</div><div class="v">${fmtInt(t.calories)} kcal</div></div>
      ${macroRow('Protein', '--c-protein', t.protein, `${fmtInt(t.protein * 4)} kcal`)}
      ${macroRow('Carbs', '--c-carbs', t.carbs, `${fmtInt(t.carbs * 4)} kcal`)}
      ${macroRow('Fat', '--c-fat', t.fat, `${fmtInt(t.fat * 9)} kcal`)}
      ${macroRow('Fiber', '--c-fiber', t.fiber, '14 g per 1,000 kcal')}
    </div>
    ${Math.abs(kcal - t.calories) > Math.max(50, t.calories * 0.05) ? html`<p class="tag warn">Your macros add up to ${fmtInt(kcal)} kcal, not ${fmtInt(t.calories)}.</p>` : ''}
    <p class="explain">BMR is the energy your body uses at rest. TDEE multiplies it by your activity level. ${p.goal === 'lose' ? 'For weight loss NutriLog subtracts up to 500 kcal (never more than 20% of TDEE, and never below a safe minimum).' : p.goal === 'gain' ? 'For weight gain NutriLog adds 10% (250–500 kcal).' : p.goal === 'muscle' ? 'For muscle gain NutriLog adds a small 5% surplus (150–300 kcal) and raises protein.' : ''} Protein is set per kg of body weight for your goal; fat is a share of calories; carbs fill the rest.</p>`;
}

export function customTargetsForm(t) {
  const f = (name, label, v, unit) => html`<div class="field"><label for="ct-${name}">${label}</label>
    <div class="input-group"><input class="input" id="ct-${name}" name="${name}" type="number" inputmode="numeric" min="0" step="1" value="${Math.round(v)}"><span class="input-suffix">${unit}</span></div></div>`;
  return html`
    ${f('calories', 'Calories', t.calories, 'kcal')}
    <div class="grid-2">${f('protein', 'Protein', t.protein, 'g')}${f('carbs', 'Carbs', t.carbs, 'g')}${f('fat', 'Fat', t.fat, 'g')}${f('fiber', 'Fiber', t.fiber, 'g')}</div>`;
}

export function readCustomTargets(form) {
  const v = Object.fromEntries(['calories', 'protein', 'carbs', 'fat', 'fiber'].map((k) => [k, Number(form.elements.namedItem(k)?.value)]));
  if (!(v.calories >= 800 && v.calories <= 10000)) return { error: 'Calories must be between 800 and 10,000.' };
  for (const k of ['protein', 'carbs', 'fat', 'fiber']) if (!(v[k] >= 0 && v[k] <= 1500)) return { error: `Enter a valid ${k} target.` };
  return { targets: v };
}
