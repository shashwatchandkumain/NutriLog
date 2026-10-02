// Weigh-ins: "Measure" with the Cult smart scale over Bluetooth, and manual entry. Both save one
// weigh-in per day with a body-composition snapshot; automatic targets follow the new weight.
// The scale protocol lives in lib/scale-protocol.js and services/scale.js — this file is UI only.
import { html, setHTML, today, fmtNum, formatDay } from '../lib/utils.js';
import { formatWeight, kgToLb, lbToKg, trimNumber } from '../lib/nutrition.js';
import { sortWeights } from '../lib/stats.js';
import { state, weightUnit } from '../store.js';
import { openSheet, toast, $ } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { bluetoothSupport, startWeighIn } from '../services/scale.js';
import { logWeight, weighInRecord } from '../services/data.js';

const inUnit = (kg, unit) => (unit === 'lb' ? kgToLb(kg) : kg);
const signed = (v, unit) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${formatWeight(Math.abs(v), unit)}`;

const STATUS = {
  choose: ['Searching for your scale…', 'Choose “Cult Smart Scale” in the list your browser shows.'],
  found: ['Scale found', 'Connecting…'],
  connecting: ['Connecting…', 'This takes a few seconds.'],
  connected: ['Step on the scale', 'Stand still with bare feet.'],
  'no-data': ['Step on the scale', "Waiting for a reading — make sure you're standing on it."],
  weighing: ['Hold still…', 'Your weight is settling.'],
  locked: ['Reading measurement…', 'Stay on — the scale is reading your heart rate.'],
  heart: ['Reading measurement…', 'Almost done.'],
};

const UNSUPPORTED = {
  ios: "Safari on iPhone and iPad can't use Bluetooth devices. Open NutriLog in the free Bluefy browser to measure with your scale.",
  insecure: 'Bluetooth only works on a secure (https) page. Open NutriLog from its https address.',
  unsupported: 'This browser cannot connect to Bluetooth devices. Use Chrome or Edge on Android, Windows, macOS or ChromeOS.',
};

/** Simple explanation of the estimated body-composition numbers. */
export const howCalculated = () => html`
  <details class="how">
    <summary>${icon('info', 16)} How this is calculated</summary>
    <div class="explain">
      <p><b>Weight</b> and <b>heart rate</b> come straight from the scale.</p>
      <p><b>BMI</b> is weight ÷ height². <b>Body fat</b> is estimated from BMI, age and sex (Deurenberg equation); <b>lean mass</b> is your weight minus that fat. <b>Body water</b> uses the Watson equation and <b>BMR</b> (energy at rest) the Mifflin–St Jeor equation.</p>
      <p>This scale doesn't share its electrical (impedance) readings over Bluetooth, so these are <b>estimates</b> from your profile, not clinical measurements. They're most useful as a trend over weeks.</p>
    </div>
  </details>`;

/** Weigh-in result: weight, change since the previous weigh-in, and estimated metrics. */
export function resultView(record, { previous = null, unit = weightUnit(), when = '' } = {}) {
  const diff = previous ? Number(record.weight_kg) - Number(previous.weight_kg) : null;
  const since = previous ? (previous.recorded_on === today() ? 'earlier today' : formatDay(previous.recorded_on, { month: 'short', day: 'numeric' })) : '';
  const kg = (v) => (v == null ? '—' : formatWeight(v, unit));
  const pct = (v) => (v == null ? '—' : `${fmtNum(v, 1)}%`);
  const tile = (label, value, sub = '', estimate = true) => html`<div class="tile">
    <div class="tile-label">${label}${estimate ? html` <span class="tag">Estimate</span>` : ''}</div><div class="tile-value">${value}</div>${sub ? html`<div class="tile-delta">${sub}</div>` : ''}</div>`;
  return html`
    <div class="result-head">
      <div class="grow">
        ${when ? html`<div class="eyebrow">${when}</div>` : ''}
        <div class="result-weight">${trimNumber(inUnit(record.weight_kg, unit), 2)}<small> ${unit}</small></div>
        <div class="small muted">${diff == null ? 'Your first weigh-in' : `${signed(diff, unit)} since ${since}`}</div>
      </div>
      <div class="result-action" data-result-action></div>
    </div>
    <div class="tiles scale-tiles">
      ${tile('Heart rate', record.heart_rate_bpm ? html`${record.heart_rate_bpm}<small> bpm</small>` : '—', record.heart_rate_bpm ? 'from the scale' : 'not captured', false)}
      ${tile('BMI', record.bmi == null ? '—' : fmtNum(record.bmi, 1), record.bmi == null ? '' : bmiLabel(record.bmi))}
      ${tile('Body fat', pct(record.body_fat_pct), record.fat_mass_kg == null ? '' : `${kg(record.fat_mass_kg)} fat`)}
      ${tile('Lean mass', kg(record.lean_mass_kg), 'fat-free mass')}
      ${tile('Body water', pct(record.body_water_pct), record.body_water_l == null ? '' : `${fmtNum(record.body_water_l, 1)} L`)}
      ${tile('BMR', record.bmr_kcal == null ? '—' : html`${fmtNum(record.bmr_kcal, 1)}<small> kcal</small>`, 'energy at rest per day')}
    </div>`;
}

const bmiLabel = (b) => (b < 18.5 ? 'underweight range' : b < 25 ? 'healthy range' : b < 30 ? 'overweight range' : 'obese range');

/** Troubleshooting for the Bluetooth connection. */
export function openBluetoothHelp() {
  const sheet = openSheet({ title: 'Bluetooth help' });
  setHTML(sheet.body, html`<div class="stack">
    <ol class="help-list">
      <li><b>Use a supported browser.</b> Chrome or Edge on Android, Windows, macOS or ChromeOS. On iPhone or iPad use the free Bluefy browser — Safari can't connect to Bluetooth devices.</li>
      <li><b>Turn Bluetooth on</b> and allow the browser to use it. On Android, Chrome may also need Location (“Nearby devices”) permission.</li>
      <li><b>Wake the scale first.</b> Step on it, then tap Connect — the scale is only visible while it's switched on.</li>
      <li><b>Close the Cult app</b> or turn off Bluetooth on other phones nearby; the scale accepts one connection at a time.</li>
      <li><b>Allowed Bluetooth for this site earlier and blocked it?</b> Open the site settings (the icon left of the address bar) and set Bluetooth to Allow.</li>
      <li>Keep your phone or laptop within a few metres of the scale.</li>
    </ol>
    <p class="small muted">Readings go straight from the scale to your account; nothing is shared with anyone else.</p>
  </div>`);
  return sheet;
}

/** Opens the smart-scale sheet: a short "get ready" step, then the live measurement. */
export function openScale() {
  const support = bluetoothSupport();
  let handle = null;
  const sheet = openSheet({ title: 'Measure with smart scale', onClose: () => handle?.cancel() });
  const unit = weightUnit();

  const manual = () => { sheet.close(); openWeightSheet(); };

  if (support !== 'ok') {
    setHTML(sheet.body, html`<div class="empty"><div class="empty-icon">${icon('bluetooth', 24)}</div>
      <div class="empty-title">Bluetooth isn't available here</div><div class="empty-sub">${UNSUPPORTED[support]}</div>
      <div class="row" style="justify-content:center"><button type="button" class="btn btn-secondary btn-sm" data-manual>Enter weight manually</button>
      <button type="button" class="btn btn-ghost btn-sm" data-help>Bluetooth help</button></div></div>`);
    sheet.body.querySelector('[data-manual]').addEventListener('click', manual);
    sheet.body.querySelector('[data-help]').addEventListener('click', openBluetoothHelp);
    return sheet;
  }

  const intro = () => {
    sheet.setTitle('Measure with smart scale');
    setHTML(sheet.body, html`<div class="stack scale-intro">
      <div class="scale-hero" aria-hidden="true">${icon('scale', 40)}</div>
      <ol class="steps-list">
        <li>Turn on Bluetooth on this device.</li>
        <li>Step on your <b>Cult Smart Scale</b> with bare feet to wake it up.</li>
        <li>Tap <b>Connect</b> and choose “Cult Smart Scale”.</li>
      </ol>
      <button type="button" class="btn btn-primary btn-lg btn-block" data-connect>${icon('bluetooth', 18)} Connect</button>
      <div class="row" style="justify-content:center"><button type="button" class="btn btn-ghost btn-sm" data-help>Bluetooth help</button>
        <button type="button" class="btn btn-ghost btn-sm" data-manual>Enter manually</button></div>
    </div>`);
    // requestDevice must run inside this click (the browser requires a user gesture).
    sheet.body.querySelector('[data-connect]').addEventListener('click', measure);
    sheet.body.querySelector('[data-help]').addEventListener('click', openBluetoothHelp);
    sheet.body.querySelector('[data-manual]').addEventListener('click', manual);
  };

  const showResult = ({ weightKg, heartRate }) => {
    const measuredAt = new Date().toISOString();
    const record = weighInRecord(weightKg, { source: 'scale', measuredAt, heartRate });
    const weights = sortWeights(state.weights);
    const todays = weights.find((w) => w.recorded_on === today());
    const previous = weights[weights.length - 1]; // the latest weigh-in, which may be earlier today
    const p = state.profile || {};
    sheet.setTitle('Measurement complete');
    setHTML(sheet.body, html`
      <div class="stack">
        <div class="result-card">${resultView(record, { previous, unit, when: `Measured ${new Date(measuredAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` })}</div>
        ${!(p.height_cm && p.age) ? html`<div class="form-note">Add your height and age in Settings → Profile to see body composition.</div>` : ''}
        ${howCalculated()}
        <p class="tiny faint">${todays ? `Saving replaces today's ${formatWeight(todays.weight_kg, unit)} entry. ` : ''}${state.goals?.is_custom ? 'Your custom targets stay as they are.' : 'Your calorie and macro targets will update to the new weight.'}</p>
        <div class="row between wrap">
          <button type="button" class="btn btn-ghost btn-sm" data-again>${icon('refresh', 16)} Measure again</button>
          <button type="button" class="btn btn-primary" data-log aria-label="Save this weigh-in">${icon('check', 18)} Log this</button>
        </div>
      </div>`);
    // Put the save button next to the weight as well, so it's reachable without scrolling.
    const slot = sheet.body.querySelector('[data-result-action]');
    if (slot) setHTML(slot, html`<button type="button" class="btn btn-primary btn-sm" data-log aria-label="Save this weigh-in">${icon('check', 16)} Log this</button>`);
    const save = () => {
      logWeight(today(), weightKg, { record });
      sheet.close();
      toast(`Weight saved ✓ ${formatWeight(weightKg, unit)}${record.heart_rate_bpm ? ` · ${record.heart_rate_bpm} bpm` : ''}`, 'success');
    };
    sheet.body.querySelectorAll('[data-log]').forEach((b) => b.addEventListener('click', save));
    sheet.body.querySelector('[data-again]').addEventListener('click', intro);
  };

  const showError = (err) => {
    sheet.setTitle('Measure with smart scale');
    const dismissed = err?.dismissed;
    setHTML(sheet.body, html`<div class="empty"><div class="empty-icon">${icon('bluetooth', 24)}</div>
      <div class="empty-title">${dismissed ? 'No scale selected' : "Couldn't connect to your scale"}</div>
      <div class="empty-sub">${dismissed ? 'Step on the scale so it wakes up, then tap Try again and pick “Cult Smart Scale”.' : err?.userMessage || 'Please try again.'}</div>
      <div class="row wrap" style="justify-content:center"><button type="button" class="btn btn-primary btn-sm" data-retry>Try again</button>
      <button type="button" class="btn btn-secondary btn-sm" data-help>Bluetooth help</button>
      <button type="button" class="btn btn-ghost btn-sm" data-manual>Enter manually</button></div></div>`);
    sheet.body.querySelector('[data-retry]').addEventListener('click', intro);
    sheet.body.querySelector('[data-help]').addEventListener('click', openBluetoothHelp);
    sheet.body.querySelector('[data-manual]').addEventListener('click', manual);
  };

  function measure() {
    handle?.cancel();
    sheet.setTitle('Measuring');
    setHTML(sheet.body, html`
      <div class="weigh" aria-live="polite">
        <p class="weigh-status"><b id="sc-status">${STATUS.choose[0]}</b><span id="sc-detail">${STATUS.choose[1]}</span></p>
        <div class="weigh-readout"><span class="weigh-value" id="sc-weight">0.00</span><span class="weigh-unit">${unit}</span></div>
        <div class="weigh-pulse" id="sc-hr" hidden><span class="heart" aria-hidden="true">♥</span><span id="sc-hr-val">—</span><span class="hr-unit">bpm</span></div>
        <div class="weigh-track" aria-hidden="true"><span id="sc-bar"></span></div>
        <button type="button" class="btn btn-ghost btn-sm" data-cancel-measure>Cancel</button>
      </div>`);
    sheet.body.querySelector('[data-cancel-measure]').addEventListener('click', () => { handle?.cancel(); intro(); });
    const status = (key) => {
      const [title, detail] = STATUS[key] || [key, ''];
      const a = $('#sc-status', sheet.body), b = $('#sc-detail', sheet.body);
      if (a) a.textContent = title;
      if (b) b.textContent = detail;
    };
    const bar = (pct) => { const el = $('#sc-bar', sheet.body); if (el) el.style.width = `${pct}%`; };
    const weight = (kg) => { const el = $('#sc-weight', sheet.body); if (el) el.textContent = inUnit(kg, unit).toFixed(2); };
    const heart = (bpm) => {
      const box = $('#sc-hr', sheet.body);
      if (!box) return;
      box.hidden = false;
      $('#sc-hr-val', sheet.body).textContent = String(bpm);
    };
    let locked = false;
    handle = startWeighIn({
      status: (s) => { status(s); if (s === 'found') bar(8); if (s === 'connected') bar(15); },
      live: ({ weightKg, locked: isLocked }) => {
        weight(weightKg);
        if (!isLocked && !locked && weightKg > 0) { status('weighing'); bar(35); }
      },
      locked: ({ weightKg }) => { locked = true; weight(weightKg); status('locked'); bar(60); },
      heart: ({ heartRate, ticks }) => { heart(heartRate); status('heart'); bar(Math.min(95, 60 + ticks * 12)); },
      complete: (r) => { bar(100); showResult(r); },
      disconnected: () => showError({ userMessage: 'The scale switched off before your weight settled. Step on it again and tap Try again.' }),
      error: showError,
    });
  }

  intro();
  return sheet;
}

/** Manual weigh-in for any day (one entry per day — a second one replaces it). */
export function openWeightSheet({ date = today() } = {}) {
  const unit = weightUnit();
  const latest = sortWeights(state.weights).slice(-1)[0];
  const sheet = openSheet({ title: 'Log weight', footer: true });
  const shown = latest ? trimNumber(inUnit(latest.weight_kg, unit), 2) : '';
  setHTML(sheet.body, html`
    <form class="stack" id="w-form" novalidate>
      <div class="grid-2">
        <div class="field"><label for="w-val">Weight</label><div class="input-group"><input class="input" id="w-val" type="number" inputmode="decimal" step="0.01" value="${shown}" required><span class="input-suffix">${unit}</span></div></div>
        <div class="field"><label for="w-date">Date</label><input class="input" id="w-date" type="date" max="${today()}" value="${date}" required></div>
      </div>
      <p class="hint">One entry per day — logging again on the same day replaces it. Have a Cult smart scale? Use “Measure” instead.</p>
    </form>`);
  setHTML(sheet.foot, html`<button type="button" class="btn btn-secondary" data-cancel>Cancel</button><button type="button" class="btn btn-primary" data-save>Save</button>`);
  const save = () => {
    const v = Number($('#w-val', sheet.body).value);
    const d = $('#w-date', sheet.body).value;
    const kg = unit === 'lb' ? lbToKg(v) : v;
    if (!(kg >= 20 && kg <= 400)) { toast(`Enter a weight between ${unit === 'lb' ? '44 and 880 lb' : '20 and 400 kg'}.`, 'error'); return; }
    if (!d || d > today()) { toast('Pick a date that is not in the future.', 'error'); return; }
    logWeight(d, kg, { source: 'manual' });
    sheet.close();
    toast(`Weight saved ✓ ${formatWeight(kg, unit)}`, 'success');
  };
  sheet.foot.querySelector('[data-save]').addEventListener('click', save);
  sheet.foot.querySelector('[data-cancel]').addEventListener('click', () => sheet.close());
  $('#w-form', sheet.body).addEventListener('submit', (e) => { e.preventDefault(); save(); });
  return sheet;
}
