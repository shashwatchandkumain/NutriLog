// Logging activities — common presets (with intensity), treadmill by speed and incline, an
// AI description, or calories from a watch. Used inline on the Activity page and as a sheet
// from the dashboard. Burned calories use the user's weight on that day (see data.js).
import { html, setHTML, fmtNum, formatDay } from '../lib/utils.js';
import { formatWeight, trimNumber } from '../lib/nutrition.js';
import { ACTIVITY_PRESETS, INTENSITY_LABEL, presetMet, netActivityCalories, treadmillMet, TREADMILL_RUN_KMH } from '../lib/activity.js';
import { state, weightUnit } from '../store.js';
import { $, toast, showError, withBusy, openSheet } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { logActivity, weightOnDate } from '../services/data.js';
import { analyzeActivity } from '../services/ai.js';

const OTHER = { id: 'other', name: 'Other (enter calories)', emoji: '⌚' };

/**
 * Renders the activity form into `container`. `getDate()` gives the day to log on;
 * `onLogged(rows)` runs after logging. Returns a refresh function (e.g. after a weigh-in).
 */
export function renderActivityForm(container, { getDate, onLogged }) {
  let preset = null;
  let intensity = 'moderate';
  let runMode = null; // treadmill: null = decide by speed, or 'walk' | 'run'
  setHTML(container, html`
    <div class="chips" role="group" aria-label="Activity">${[...ACTIVITY_PRESETS, OTHER].map((a) => html`<button type="button" class="chip" data-preset="${a.id}" aria-pressed="false">${a.emoji} ${a.name}</button>`)}</div>
    <form class="stack-sm activity-form" style="margin-top:12px" hidden novalidate>
      <div class="row wrap">
        <input class="input other-only" name="name" maxlength="120" placeholder="Activity name" aria-label="Activity name" style="max-width:220px">
        <div class="input-group" style="max-width:150px"><input class="input" name="minutes" type="number" inputmode="numeric" min="1" max="600" placeholder="Minutes" aria-label="Duration in minutes" required><span class="input-suffix">min</span></div>
        <div class="input-group other-only" style="max-width:160px"><input class="input" name="kcal" type="number" inputmode="decimal" min="1" max="5000" step="any" placeholder="Calories" aria-label="Active calories burned"><span class="input-suffix">kcal</span></div>
        <div class="input-group treadmill-only" style="max-width:150px"><input class="input" name="speed" type="number" inputmode="decimal" min="1" max="25" step="0.1" placeholder="Speed" aria-label="Speed in km/h"><span class="input-suffix">km/h</span></div>
        <div class="input-group treadmill-only" style="max-width:130px"><input class="input" name="incline" type="number" inputmode="decimal" min="0" max="40" step="0.5" placeholder="Incline" aria-label="Incline in percent" value="0"><span class="input-suffix">%</span></div>
        <div class="segmented treadmill-only" role="group" aria-label="Walking or running">
          <button type="button" data-run="walk" aria-pressed="false">Walk</button><button type="button" data-run="run" aria-pressed="false">Run</button>
        </div>
        <div class="segmented intensity-only" role="group" aria-label="Intensity"></div>
      </div>
      <div class="row between wrap">
        <span class="small muted grow" data-estimate aria-live="polite"></span>
        <button class="btn btn-primary" type="submit">Log</button>
      </div>
    </form>
    <div class="divider">or describe it</div>
    <form class="stack-sm ai-activity">
      <textarea class="textarea" name="text" maxlength="500" rows="2" placeholder="e.g. 30 min treadmill at 6 km/h, 2% incline and 20 min of weights" aria-label="Describe your activity"></textarea>
      <button class="btn btn-secondary" type="submit" style="align-self:flex-end">${icon('sparkles', 16)} Estimate with AI</button>
    </form>`);
  const form = $('.activity-form', container);
  const est = $('[data-estimate]', container);

  const met = () => {
    if (!preset || preset.id === 'other') return null;
    if (preset.treadmill) return treadmillMet({ speedKmh: Number(form.speed.value), inclinePct: Number(form.incline.value), mode: runMode });
    return presetMet(preset, intensity);
  };
  const name = () => {
    if (preset.id === 'other') return String(form.elements.namedItem('name').value || '').trim() || 'Activity';
    if (!preset.treadmill) return preset.intensities && intensity !== 'moderate' ? `${preset.name} · ${INTENSITY_LABEL[intensity].toLowerCase()}` : preset.name;
    const speed = Number(form.speed.value), incline = Number(form.incline.value) || 0;
    const mode = runMode || (speed >= TREADMILL_RUN_KMH ? 'run' : 'walk');
    return `Treadmill ${mode === 'run' ? 'run' : 'walk'} · ${trimNumber(speed, 1)} km/h${incline ? ` · ${trimNumber(incline, 1)}% incline` : ''}`;
  };
  const update = () => {
    const m = Number(form.minutes.value);
    if (preset?.treadmill) {
      const auto = Number(form.speed.value) >= TREADMILL_RUN_KMH ? 'run' : 'walk';
      form.querySelectorAll('[data-run]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.run === (runMode || auto))));
    }
    if (preset?.id === 'other') { est.textContent = 'Enter the active calories from your watch or machine.'; return; }
    const value = met();
    const w = weightOnDate(getDate());
    est.textContent = preset && value && m > 0 && w
      ? `≈ ${fmtNum(netActivityCalories(Math.round(value * 100) / 100, w, m), 1)} kcal · MET ${trimNumber(value, 2)} · at ${formatWeight(w, weightUnit())}`
      : preset?.treadmill ? 'Enter minutes and speed.' : preset ? 'Enter how many minutes.' : '';
  };
  const select = (el) => {
    preset = [...ACTIVITY_PRESETS, OTHER].find((a) => a.id === el.dataset.preset);
    intensity = 'moderate'; runMode = null;
    container.querySelectorAll('[data-preset]').forEach((b) => b.setAttribute('aria-pressed', String(b === el)));
    form.hidden = false;
    form.classList.toggle('is-treadmill', !!preset.treadmill);
    form.classList.toggle('is-other', preset.id === 'other');
    form.classList.toggle('has-intensity', !!preset.intensities);
    setHTML($('.intensity-only', form), html`${Object.keys(preset.intensities || {}).map((k) => html`<button type="button" data-intensity="${k}" aria-pressed="${k === intensity}">${INTENSITY_LABEL[k]}</button>`)}`);
    (preset.id === 'other' ? form.elements.namedItem('name') : form.minutes).focus();
    update();
  };

  container.addEventListener('click', (e) => {
    const p = e.target.closest('[data-preset]');
    if (p) { select(p); return; }
    const r = e.target.closest('[data-run]');
    if (r) { runMode = r.dataset.run; update(); return; }
    const i = e.target.closest('[data-intensity]');
    if (i) {
      intensity = i.dataset.intensity;
      form.querySelectorAll('[data-intensity]').forEach((b) => b.setAttribute('aria-pressed', String(b === i)));
      update();
    }
  });
  form.addEventListener('input', update);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const m = Number(form.minutes.value);
    if (!preset || !(m >= 1 && m <= 600)) { toast('Enter minutes between 1 and 600.', 'error'); form.minutes.focus(); return; }
    let row;
    if (preset.id === 'other') {
      const kcal = Number(form.kcal.value);
      if (!(kcal > 0 && kcal <= 5000)) { toast('Enter the calories burned (1–5,000).', 'error'); form.kcal.focus(); return; }
      row = logActivity(getDate(), { name: name(), duration_min: m, calories_burned: kcal, source: 'manual' });
    } else {
      const value = met();
      if (!value) { toast('Enter your treadmill speed in km/h.', 'error'); form.speed.focus(); return; }
      row = logActivity(getDate(), { name: name(), duration_min: m, met: value, source: 'preset' });
    }
    toast(`${row.name} logged ✓ · ${fmtNum(row.calories_burned, 1)} kcal`, 'success');
    form.reset(); form.hidden = true; preset = null;
    container.querySelectorAll('[data-preset]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
    onLogged?.([row]);
  });

  const aiForm = $('.ai-activity', container);
  aiForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = aiForm.text.value.trim();
    if (!text) { toast('Describe your activity first.', 'error'); return; }
    withBusy(aiForm.querySelector('[type=submit]'), 'Estimating…', async () => {
      try {
        const date = getDate();
        const items = await analyzeActivity(text, weightOnDate(date));
        if (!items.length) { toast("Couldn't find an activity in that description.", 'error'); return; }
        reviewActivities(items, date, (rows) => { aiForm.reset(); onLogged?.(rows); });
      } catch (err) { showError(err, 'activity AI'); }
    });
  });
  return update;
}

/** AI-estimated activities, shown for confirmation before they are logged. */
function reviewActivities(items, date, onDone) {
  const w = weightOnDate(date);
  const kcal = (a) => (w ? netActivityCalories(a.met, w, a.duration_min) : Number(a.calories_burned) || 0);
  const sheet = openSheet({ title: 'Add activities', footer: true });
  setHTML(sheet.body, html`<div class="stack-sm">
    <div class="form-note">${icon('sparkles', 16)} <span><b>AI estimate.</b> Check the activities and minutes before adding them.</span></div>
    ${items.map((a) => html`
    <div class="item"><div class="item-main"><div class="item-name">${a.name}</div><div class="item-meta">${a.duration_min} min · MET ${trimNumber(a.met, 2)}</div></div><div class="item-kcal">${fmtNum(kcal(a), 1)} <small>kcal</small></div></div>`)}
    <p class="tiny faint">Net calories above resting, for your weight on ${formatDay(date)}${w ? ` (${formatWeight(w, weightUnit())})` : ''}.</p></div>`);
  setHTML(sheet.foot, html`<button type="button" class="btn btn-secondary" data-cancel>Cancel</button><button type="button" class="btn btn-primary" data-ok>Add ${items.length}</button>`);
  sheet.foot.querySelector('[data-cancel]').addEventListener('click', () => sheet.close());
  sheet.foot.querySelector('[data-ok]').addEventListener('click', () => {
    const rows = items.map((a) => logActivity(date, { name: a.name, duration_min: a.duration_min, met: a.met, source: 'ai' }));
    sheet.close(); onDone?.(rows);
    toast(`${items.length} activit${items.length === 1 ? 'y' : 'ies'} logged ✓`, 'success');
  });
}

/** The activity form in a sheet (dashboard quick action). */
export function openActivityLogger({ date = state.date } = {}) {
  const sheet = openSheet({ title: `Log activity · ${formatDay(date, { month: 'short', day: 'numeric' })}`, wide: true });
  const box = document.createElement('div');
  sheet.body.appendChild(box);
  renderActivityForm(box, { getDate: () => date, onLogged: () => sheet.close() });
  return sheet;
}
