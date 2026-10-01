// Profile fields shared by onboarding and Settings. Values are stored in kg/cm; the form
// shows the user's preferred units and converts on read.
import { html } from '../lib/utils.js';
import { ACTIVITY_LEVELS, GOALS, MACRO_STYLES, kgToLb, lbToKg, cmToFtIn, ftInToCm, suggestActivityLevel } from '../lib/nutrition.js';

export const DIET_TYPES = [
  { id: 'vegetarian', label: 'Vegetarian', desc: 'No meat, fish or eggs' },
  { id: 'eggetarian', label: 'Eggetarian', desc: 'Vegetarian + eggs' },
  { id: 'non_vegetarian', label: 'Non-vegetarian', desc: 'Everything' },
  { id: 'vegan', label: 'Vegan', desc: 'No animal products' },
];
export const COMMON_ALLERGIES = ['Peanuts', 'Tree nuts', 'Milk / lactose', 'Gluten', 'Soy', 'Eggs', 'Fish', 'Shellfish', 'Sesame'];
const STEP_OPTIONS = [
  { v: '', label: 'Not sure' }, { v: '3000', label: 'Under 5,000' }, { v: '6000', label: '5,000–7,500' },
  { v: '8500', label: '7,500–10,000' }, { v: '11000', label: '10,000–12,500' }, { v: '14000', label: 'Over 12,500' },
];

const r1 = (v) => Math.round(v * 10) / 10;
const pressed = (a, b) => String(a === b);

export function basicsFields(p, prefs) {
  return html`
    <div class="field"><label for="pf-name">Name <span class="faint">(optional)</span></label>
      <input class="input" id="pf-name" name="display_name" maxlength="80" autocomplete="given-name" value="${p.display_name || ''}"></div>
    <div class="grid-2">
      <div class="field"><label for="pf-age">Age</label>
        <input class="input" id="pf-age" name="age" type="number" inputmode="numeric" min="13" max="120" required value="${p.age ?? ''}"></div>
      <div class="field"><label for="pf-sex">Sex <span class="faint">(for BMR)</span></label>
        <select class="select" id="pf-sex" name="sex">
          <option value="" ${!p.sex ? 'selected' : ''}>Prefer not to say</option>
          <option value="female" ${p.sex === 'female' ? 'selected' : ''}>Female</option>
          <option value="male" ${p.sex === 'male' ? 'selected' : ''}>Male</option>
        </select></div>
    </div>
    <div class="grid-2">
      <div class="field"><span class="label" id="lbl-wu">Weight unit</span>
        <div class="segmented" role="group" aria-labelledby="lbl-wu">
          <button type="button" data-unit="weight_unit" data-v="kg" aria-pressed="${pressed(prefs.weight_unit || 'kg', 'kg')}">kg</button>
          <button type="button" data-unit="weight_unit" data-v="lb" aria-pressed="${pressed(prefs.weight_unit, 'lb')}">lb</button>
        </div></div>
      <div class="field"><span class="label" id="lbl-hu">Height unit</span>
        <div class="segmented" role="group" aria-labelledby="lbl-hu">
          <button type="button" data-unit="height_unit" data-v="cm" aria-pressed="${pressed(prefs.height_unit || 'cm', 'cm')}">cm</button>
          <button type="button" data-unit="height_unit" data-v="ftin" aria-pressed="${pressed(prefs.height_unit, 'ftin')}">ft / in</button>
        </div></div>
    </div>
    <p class="hint">Sex is only used in the BMR formula. If you prefer not to say, NutriLog uses the average of the two.</p>`;
}

export function bodyFields(p, prefs) {
  const wu = prefs.weight_unit === 'lb' ? 'lb' : 'kg';
  const showW = (kg) => (kg ? r1(wu === 'lb' ? kgToLb(Number(kg)) : Number(kg)) : '');
  let heightInputs;
  if (prefs.height_unit === 'ftin') {
    const { ft, in: inch } = p.height_cm ? cmToFtIn(Number(p.height_cm)) : { ft: '', in: '' };
    heightInputs = html`<div class="grid-2">
      <div class="input-group"><input class="input" id="pf-ft" name="height_ft" type="number" inputmode="numeric" min="3" max="8" value="${ft}" aria-label="Feet" required><span class="input-suffix">ft</span></div>
      <div class="input-group"><input class="input" name="height_in" type="number" inputmode="numeric" min="0" max="11" value="${inch}" aria-label="Inches"><span class="input-suffix">in</span></div></div>`;
  } else {
    heightInputs = html`<div class="input-group"><input class="input" id="pf-ft" name="height_cm" type="number" inputmode="decimal" min="90" max="250" step="0.1" value="${p.height_cm ? r1(Number(p.height_cm)) : ''}" required><span class="input-suffix">cm</span></div>`;
  }
  return html`
    <div class="field"><label for="pf-ft">Height</label>${heightInputs}</div>
    <div class="grid-2">
      <div class="field"><label for="pf-w">Current weight</label>
        <div class="input-group"><input class="input" id="pf-w" name="weight" type="number" inputmode="decimal" step="0.1" min="${wu === 'lb' ? 55 : 25}" max="${wu === 'lb' ? 880 : 400}" value="${showW(p.weight_kg)}" required><span class="input-suffix">${wu}</span></div></div>
      <div class="field"><label for="pf-tw">Target weight <span class="faint">(optional)</span></label>
        <div class="input-group"><input class="input" id="pf-tw" name="target_weight" type="number" inputmode="decimal" step="0.1" value="${showW(p.target_weight_kg)}"><span class="input-suffix">${wu}</span></div></div>
    </div>`;
}

export function goalFields(p) {
  const desc = { lose: 'About 0.5 kg a week', maintain: 'Stay where you are', gain: 'Gradual, lean gain', muscle: 'Small surplus, high protein' };
  return html`<div class="choices" role="group" aria-label="Goal">
    ${Object.entries(GOALS).map(([id, g]) => html`<button type="button" class="choice" data-choice="goal" data-v="${id}" aria-pressed="${pressed(p.goal || 'maintain', id)}">
      <span class="choice-title">${g.label}</span><span class="choice-desc">${desc[id]}</span></button>`)}
  </div>`;
}

export function activityFields(p) {
  return html`
    <div class="grid-2">
      <div class="field"><label for="pf-steps">Daily steps</label>
        <select class="select" id="pf-steps" name="daily_steps">${STEP_OPTIONS.map((o) => html`<option value="${o.v}" ${String(p.daily_steps ?? '') === o.v ? 'selected' : ''}>${o.label}</option>`)}</select></div>
      <div class="field"><label for="pf-wk">Workouts per week</label>
        <select class="select" id="pf-wk" name="workouts_per_week">${[0, 1, 2, 3, 4, 5, 6, 7].map((n) => html`<option value="${n}" ${Number(p.workouts_per_week ?? 0) === n ? 'selected' : ''}>${n}</option>`)}</select></div>
    </div>
    <div class="field"><span class="label">Activity level</span>
      <div class="choices" role="group" aria-label="Activity level" style="grid-template-columns:1fr">
        ${Object.entries(ACTIVITY_LEVELS).map(([id, a]) => html`<button type="button" class="choice" data-choice="activity_level" data-v="${id}" aria-pressed="${pressed(p.activity_level || 'sedentary', id)}">
          <span class="choice-title">${a.label} <span class="faint small">×${a.multiplier}</span></span><span class="choice-desc">${a.description}</span></button>`)}
      </div>
      <span class="hint">Changing steps or workouts suggests a level — you can still pick another.</span>
    </div>`;
}

export function dietFields(p) {
  const allergies = new Set(p.allergies || []);
  const custom = [...allergies].filter((a) => !COMMON_ALLERGIES.includes(a));
  return html`
    <div class="field"><span class="label">Diet <span class="faint">(optional)</span></span>
      <div class="choices" role="group" aria-label="Diet type">
        ${DIET_TYPES.map((d) => html`<button type="button" class="choice" data-choice="diet_type" data-v="${d.id}" data-toggleable="1" aria-pressed="${pressed(p.diet_type, d.id)}"><span class="choice-title">${d.label}</span><span class="choice-desc">${d.desc}</span></button>`)}
      </div></div>
    <div class="field"><span class="label">Macro style</span>
      <div class="segmented" role="group" aria-label="Macro style">
        ${Object.entries(MACRO_STYLES).map(([id, m]) => html`<button type="button" data-choice="macro_style" data-v="${id}" aria-pressed="${pressed(p.macro_style || 'balanced', id)}">${m.label}</button>`)}
      </div></div>
    <div class="field"><span class="label">Allergies / avoid <span class="faint">(optional)</span></span>
      <div class="chips" role="group" aria-label="Allergies">
        ${COMMON_ALLERGIES.map((a) => html`<button type="button" class="chip" data-allergy="${a}" aria-pressed="${String(allergies.has(a))}">${a}</button>`)}
      </div>
      <input class="input" name="allergies_other" maxlength="200" placeholder="Other (comma separated)" value="${custom.join(', ')}" style="margin-top:8px">
      <span class="hint">Used to keep AI meal suggestions safe for you.</span>
    </div>`;
}

/**
 * Wires the interactive parts (choices, unit toggles, allergy chips) of a profile form.
 * `model` holds the non-input values; `onUnitChange` re-renders when units switch.
 */
export function bindProfileForm(form, model, { onUnitChange } = {}) {
  form.addEventListener('click', (e) => {
    const c = e.target.closest('[data-choice]');
    if (c) {
      const key = c.dataset.choice;
      const same = model[key] === c.dataset.v;
      model[key] = same && c.dataset.toggleable ? null : c.dataset.v;
      form.querySelectorAll(`[data-choice="${key}"]`).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === model[key])));
      return;
    }
    const u = e.target.closest('[data-unit]');
    if (u) {
      readInto(form, model);
      model.prefs[u.dataset.unit] = u.dataset.v;
      onUnitChange?.();
      return;
    }
    const a = e.target.closest('[data-allergy]');
    if (a) {
      const on = a.getAttribute('aria-pressed') !== 'true';
      a.setAttribute('aria-pressed', String(on));
    }
  });
  form.addEventListener('change', (e) => {
    if (e.target.name === 'daily_steps' || e.target.name === 'workouts_per_week') {
      const steps = form.daily_steps?.value, workouts = form.workouts_per_week?.value;
      const level = suggestActivityLevel({ dailySteps: steps, workoutsPerWeek: workouts });
      model.activity_level = level;
      form.querySelectorAll('[data-choice="activity_level"]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === level)));
    }
  });
}

/** Copies whatever fields are present in the form into `model` (kg/cm). */
export function readInto(form, model) {
  const f = (n) => form.elements.namedItem(n);
  const val = (n) => (f(n) ? String(f(n).value).trim() : undefined);
  const wu = model.prefs.weight_unit === 'lb' ? 'lb' : 'kg';
  const toKg = (v) => (v === '' || v == null ? null : wu === 'lb' ? lbToKg(Number(v)) : Number(v));
  if (f('display_name')) model.display_name = val('display_name') || null;
  if (f('age')) model.age = val('age') === '' ? null : Number(val('age'));
  if (f('sex')) model.sex = val('sex') || null;
  if (f('height_cm')) model.height_cm = val('height_cm') === '' ? null : Number(val('height_cm'));
  if (f('height_ft')) model.height_cm = val('height_ft') === '' ? null : r1(ftInToCm(val('height_ft'), val('height_in') || 0));
  if (f('weight')) model.weight_kg = toKg(val('weight'));
  if (f('target_weight')) model.target_weight_kg = toKg(val('target_weight'));
  if (f('daily_steps')) model.daily_steps = val('daily_steps') === '' ? null : Number(val('daily_steps'));
  if (f('workouts_per_week')) model.workouts_per_week = Number(val('workouts_per_week')) || 0;
  if (form.querySelector('[data-allergy]')) {
    const chips = [...form.querySelectorAll('[data-allergy][aria-pressed="true"]')].map((b) => b.dataset.allergy);
    const other = (val('allergies_other') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10);
    model.allergies = [...new Set([...chips, ...other])].map((s) => s.slice(0, 40)).slice(0, 20);
  }
  return model;
}

/** Returns a list of problems for the fields that are required to compute targets. */
export function validateProfile(m, { requireBody = true } = {}) {
  const errs = [];
  if (m.age != null && !(m.age >= 13 && m.age <= 120)) errs.push('Age must be between 13 and 120.');
  if (requireBody) {
    if (m.age == null) errs.push('Enter your age.');
    if (!(m.height_cm >= 90 && m.height_cm <= 250)) errs.push('Enter a height between 90 and 250 cm (3 ft – 8 ft 2 in).');
    if (!(m.weight_kg >= 25 && m.weight_kg <= 400)) errs.push('Enter a weight between 25 and 400 kg (55 – 880 lb).');
  }
  if (m.target_weight_kg != null && !(m.target_weight_kg >= 25 && m.target_weight_kg <= 400)) errs.push('Target weight looks out of range.');
  return errs;
}

/** Columns of `profiles` that the forms edit. */
export function profilePatch(m) {
  const round1 = (v) => (v == null ? null : r1(v));
  return {
    display_name: m.display_name ?? null, age: m.age ?? null, sex: m.sex || null,
    height_cm: round1(m.height_cm), weight_kg: round1(m.weight_kg), target_weight_kg: round1(m.target_weight_kg),
    goal: m.goal || 'maintain', activity_level: m.activity_level || 'sedentary',
    daily_steps: m.daily_steps ?? null, workouts_per_week: m.workouts_per_week ?? null,
    diet_type: m.diet_type || null, macro_style: m.macro_style || 'balanced', allergies: m.allergies || [],
  };
}
