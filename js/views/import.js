// Settings → Import a profile: a NutriLog export (from this or another account) or a
// smart-scale (occult) backup. Imports are additive and idempotent: existing days are kept,
// and importing the same file again changes nothing.
import { html, setHTML, fmtInt, today, daysBetween, formatDay } from '../lib/utils.js';
import { formatWeight, formatHeight } from '../lib/nutrition.js';
import {
  detectFormat, scaleProfiles, scaleWeighIns, scaleProfilePatch,
  nutrilogSummary, nutrilogProfilePatch, nutrilogGoals, nutrilogWeighIns, nutrilogItems, nutrilogActivities, nutrilogWater, nutrilogFavorites,
} from '../lib/import-formats.js';
import { state, weightUnit, heightUnit } from '../store.js';
import { openSheet, toast, showError, withBusy, $ } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { importRecords, weighInRecord, saveProfile, saveGoals, syncAutoTargets } from '../services/data.js';

const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Age on a past date, from today's age. */
const ageOn = (age, date) => (age ? Math.max(13, Number(age) - Math.floor(daysBetween(date, today()) / 365.25)) : age);

/** Weigh-in rows ready for the database. Body composition uses the profile as it was then. */
function weighInRows(list, profile) {
  return list.map((w) => ({
    ...(w.composition
      ? { weight_kg: w.kg, source: 'import', measured_at: w.measuredAt, heart_rate_bpm: w.heartRate, ...w.composition }
      : weighInRecord(w.kg, { source: 'import', measuredAt: w.measuredAt, heartRate: w.heartRate, profile: { ...profile, age: ageOn(profile.age, w.date) } })),
    recorded_on: w.date,
  }));
}

const check = (name, label, sub, checked = true) => html`
  <label class="check import-option"><input type="checkbox" name="${name}" ${checked ? 'checked' : ''}><span><b>${label}</b>${sub ? html`<span class="d">${sub}</span>` : ''}</span></label>`;

export function openImport() {
  const sheet = openSheet({ title: 'Import a profile', wide: true, footer: true });

  const pickFile = () => {
    sheet.setTitle('Import a profile');
    setHTML(sheet.body, html`
      <div class="stack">
        <p class="muted">Bring data into <b>your</b> account from:</p>
        <ul class="import-list">
          <li><b>A NutriLog export</b> — Settings → Export → JSON, from this or another person's account.</li>
          <li><b>A smart-scale backup</b> — the JSON export of the occult smart-scale app, with one or more household profiles.</li>
        </ul>
        <label class="btn btn-secondary file-btn">${icon('upload', 18)} Choose a .json file<input type="file" accept="application/json,.json" id="imp-file" class="sr-only"></label>
        <p class="tiny faint">Days that already have a weigh-in or water entry are kept, and importing the same file twice never creates duplicates.</p>
      </div>`);
    setHTML(sheet.foot, html`<button type="button" class="btn btn-secondary" data-cancel>Cancel</button>`);
    sheet.foot.querySelector('[data-cancel]').addEventListener('click', () => sheet.close());
    $('#imp-file', sheet.body).addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (file.size > MAX_FILE_BYTES) { toast('That file is too large (max 20 MB).', 'error'); return; }
      let data;
      try { data = JSON.parse(await file.text()); } catch { toast("That file isn't valid JSON.", 'error'); return; }
      const format = detectFormat(data);
      if (format === 'scale') scaleStep(data);
      else if (format === 'nutrilog') nutrilogStep(data);
      else toast("This file isn't a NutriLog export or a smart-scale backup.", 'error');
    });
  };

  // ── Smart-scale backup ─────────────────────────────────────────────────
  const scaleStep = (data) => {
    const profiles = scaleProfiles(data).filter((p) => p.readings > 0);
    if (!profiles.length) { toast('This backup has no weigh-ins to import.', 'error'); return; }
    sheet.setTitle('Import from smart scale');
    const unit = weightUnit(), hu = heightUnit();
    setHTML(sheet.body, html`
      <form class="stack" id="imp-form">
        <span class="label">Which profile?</span>
        <div class="choices" role="radiogroup" aria-label="Profile">
          ${profiles.map((p, i) => html`<label class="choice import-choice"><input type="radio" name="which" value="${i}" ${i === 0 ? 'checked' : ''}>
            <span class="choice-title">${p.name}</span>
            <span class="choice-desc">${[p.sex, p.age ? `${p.age} yrs` : null, p.heightCm ? formatHeight(p.heightCm, hu) : null].filter(Boolean).join(' · ') || 'No details'} · ${fmtInt(p.readings)} reading${p.readings === 1 ? '' : 's'}</span></label>`)}
        </div>
        ${check('weights', 'Weigh-ins', 'One per day (the latest reading of each day), with heart rate and body composition.')}
        ${check('use_profile', "Use this profile's sex, age and height for my profile", 'Turn on if this is your own scale profile.', false)}
        <p class="small muted" id="imp-preview"></p>
      </form>`);
    const form = $('#imp-form', sheet.body);
    const preview = () => {
      const p = profiles[Number(form.which.value)];
      const w = scaleWeighIns(data, p.id);
      const newDays = w.filter((x) => !state.weights.some((s) => s.recorded_on === x.date)).length;
      $('#imp-preview', sheet.body).textContent = w.length
        ? `${fmtInt(w.length)} day${w.length === 1 ? '' : 's'} from ${formatDay(w[0].date)} to ${formatDay(w[w.length - 1].date)} — ${fmtInt(newDays)} new for you. Latest: ${formatWeight(w[w.length - 1].kg, unit)}.`
        : 'No valid weigh-ins for this profile.';
    };
    form.addEventListener('change', preview);
    preview();
    setHTML(sheet.foot, html`<button type="button" class="btn btn-secondary" data-back>Back</button><button type="button" class="btn btn-primary" data-go>Import</button>`);
    sheet.foot.querySelector('[data-back]').addEventListener('click', pickFile);
    sheet.foot.querySelector('[data-go]').addEventListener('click', (e) => withBusy(e.currentTarget, 'Importing…', async () => {
      const p = profiles[Number(form.which.value)];
      const patch = form.use_profile.checked ? scaleProfilePatch(p) : null;
      const weights = form.weights.checked ? weighInRows(scaleWeighIns(data, p.id), { ...(state.profile || {}), ...(patch || {}) }) : [];
      await run({ patch, weights });
    }));
  };

  // ── NutriLog export ────────────────────────────────────────────────────
  const nutrilogStep = (data) => {
    const sum = nutrilogSummary(data);
    sheet.setTitle('Import NutriLog data');
    setHTML(sheet.body, html`
      <form class="stack" id="imp-form">
        <div class="form-note">Export${sum.name ? ` of <b>${sum.name}</b>` : ''}${sum.email ? ` (${sum.email})` : ''}${sum.exportedAt ? ` · ${new Date(sum.exportedAt).toLocaleDateString()}` : ''}</div>
        ${check('weights', `Weigh-ins (${fmtInt(sum.weights)})`, 'Days you already have are kept.', sum.weights > 0)}
        ${check('items', `Food log (${fmtInt(sum.items)} entries)`, '', sum.items > 0)}
        ${check('activities', `Activities (${fmtInt(sum.activities)})`, 'Calories are recalculated for your weight on each day.', sum.activities > 0)}
        ${check('water', `Water (${fmtInt(sum.water)} days)`, '', sum.water > 0)}
        ${sum.favorites ? check('favorites', `Favorite foods (${fmtInt(sum.favorites)})`, '', true) : ''}
        ${sum.hasProfile ? check('profile', 'Profile details', 'Name, age, sex, height, goal, target weight and date, activity level and diet — replaces yours.', false) : ''}
        ${sum.hasGoals ? check('goals', 'Nutrition targets', 'Replaces your current targets.', false) : ''}
        <p class="small muted" id="imp-progress" aria-live="polite"></p>
      </form>`);
    const form = $('#imp-form', sheet.body);
    const on = (name) => !!form.elements.namedItem(name)?.checked;
    setHTML(sheet.foot, html`<button type="button" class="btn btn-secondary" data-back>Back</button><button type="button" class="btn btn-primary" data-go>Import</button>`);
    sheet.foot.querySelector('[data-back]').addEventListener('click', pickFile);
    sheet.foot.querySelector('[data-go]').addEventListener('click', (e) => withBusy(e.currentTarget, 'Importing…', async () => {
      const uid = state.user?.id;
      const patch = on('profile') ? nutrilogProfilePatch(data) : null;
      const bodyProfile = { ...(state.profile || {}), ...(patch || {}) };
      await run({
        patch,
        goals: on('goals') ? nutrilogGoals(data) : null,
        weights: on('weights') ? weighInRows(nutrilogWeighIns(data), bodyProfile) : [],
        items: on('items') ? await nutrilogItems(data, uid) : [],
        activities: on('activities') ? await nutrilogActivities(data, uid) : [],
        water: on('water') ? nutrilogWater(data) : [],
        favorites: on('favorites') ? nutrilogFavorites(data) : [],
      });
    }));
  };

  const run = async ({ patch = null, goals = null, weights = [], items = [], activities = [], water = [], favorites = [] }) => {
    if (!patch && !goals && !weights.length && !items.length && !activities.length && !water.length && !favorites.length) {
      toast('Choose something to import.', 'error');
      return;
    }
    const progress = $('#imp-progress', sheet.body) || $('#imp-preview', sheet.body);
    try {
      if (patch) await saveProfile(patch);
      if (goals) await saveGoals(goals);
      const n = await importRecords({ weights, items, activities, water, favorites }, (done, total) => {
        if (progress) progress.textContent = `Importing… ${fmtInt(done)} of ${fmtInt(total)}`;
      });
      if (!goals) await syncAutoTargets().catch(() => null);
      sheet.close();
      const parts = [n.weights && `${fmtInt(n.weights)} weigh-ins`, n.items && `${fmtInt(n.items)} food entries`, n.activities && `${fmtInt(n.activities)} activities`, n.water && `${fmtInt(n.water)} water days`, n.favorites && `${fmtInt(n.favorites)} favorites`, patch && 'profile details', goals && 'targets'].filter(Boolean);
      toast(`Imported ${parts.join(', ')}.`, 'success', { duration: 6000 });
    } catch (err) {
      showError(err, 'import');
    }
  };

  pickFile();
  return sheet;
}
