// Weigh-ins: "Measure" with the Bluetooth smart scale, and manual entry. Both save one
// weigh-in per day with a body-composition snapshot; automatic targets follow the new weight.
import { html, setHTML, today, fmtNum, formatDay } from '../lib/utils.js';
import { formatWeight, kgToLb, lbToKg, trimNumber } from '../lib/nutrition.js';
import { sortWeights } from '../lib/stats.js';
import { state, weightUnit } from '../store.js';
import { openSheet, toast, $ } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { bluetoothSupport, startWeighIn } from '../services/scale.js';
import { logWeight, weighInRecord } from '../services/data.js';

const inUnit = (kg, unit) => (unit === 'lb' ? kgToLb(kg) : kg);

const STATUS = {
  choose: 'Step on the scale to wake it, then choose “Cult Smart Scale” in the list.',
  connecting: 'Connecting to the scale…',
  connected: 'Connected — stand still on the scale…',
  'no-data': "Waiting for a reading… make sure you're standing on the scale.",
  weighing: 'Weighing — hold still…',
  locked: 'Weight locked — stay on while it reads your heart rate…',
  heart: 'Reading your heart rate…',
};

/** Opens the smart-scale sheet and starts a weigh-in (call from a click). */
export function openScale() {
  const support = bluetoothSupport();
  let handle = null;
  const sheet = openSheet({ title: 'Measure with smart scale', onClose: () => handle?.cancel() });
  const unit = weightUnit();

  if (support !== 'ok') {
    const why = {
      ios: "Safari on iPhone and iPad can't use Bluetooth devices. Open NutriLog in the free Bluefy browser to measure with your scale.",
      insecure: 'Bluetooth only works on a secure (https) page. Open NutriLog from its https address.',
      unsupported: 'This browser cannot connect to Bluetooth devices. Use Chrome or Edge on Android, Windows, macOS or ChromeOS.',
    }[support];
    setHTML(sheet.body, html`<div class="empty"><div class="empty-icon">${icon('scale', 24)}</div>
      <div class="empty-title">Bluetooth isn't available here</div><div class="empty-sub">${why}</div>
      <button type="button" class="btn btn-secondary btn-sm" data-manual>Enter weight manually</button></div>`);
    sheet.body.querySelector('[data-manual]').addEventListener('click', () => { sheet.close(); openWeightSheet(); });
    return sheet;
  }

  const showResult = ({ weightKg, heartRate }) => {
    const measuredAt = new Date().toISOString();
    const record = weighInRecord(weightKg, { source: 'scale', measuredAt, heartRate });
    const weights = sortWeights(state.weights);
    const todays = weights.find((w) => w.recorded_on === today());
    const previous = weights[weights.length - 1]; // the latest weigh-in, which may be earlier today
    const diff = previous ? weightKg - Number(previous.weight_kg) : null;
    const since = previous?.recorded_on === today() ? 'earlier today' : previous ? formatDay(previous.recorded_on, { month: 'short', day: 'numeric' }) : '';
    const p = state.profile || {};
    const missing = !(p.height_cm && p.age);
    const tile = (label, value, sub = '') => html`<div class="tile"><div class="tile-label">${label}</div><div class="tile-value">${value}</div>${sub ? html`<div class="tile-delta">${sub}</div>` : ''}</div>`;
    const kg = (v) => (v == null ? '—' : formatWeight(v, unit));
    const pct = (v) => (v == null ? '—' : `${fmtNum(v, 1)}%`);
    sheet.setTitle('Measurement complete');
    setHTML(sheet.body, html`
      <div class="stack">
        <div class="scale-result">
          <div class="grow">
            <div class="eyebrow">Measured ${new Date(measuredAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</div>
            <div class="scale-result-weight">${trimNumber(inUnit(weightKg, unit), 2)}<small> ${unit}</small></div>
            <div class="small muted">${diff == null ? 'Your first weigh-in' : `${diff > 0 ? '+' : diff < 0 ? '−' : '±'}${formatWeight(Math.abs(diff), unit)} since ${since}`}</div>
          </div>
          <button type="button" class="btn btn-primary btn-sm" data-log>${icon('plus', 16)} Log this</button>
        </div>
        <div class="tiles scale-tiles">
          ${tile('Heart rate', record.heart_rate_bpm ? html`${record.heart_rate_bpm}<small> bpm</small>` : '—', record.heart_rate_bpm ? 'from the scale' : 'not captured this time')}
          ${tile('BMI', record.bmi == null ? '—' : fmtNum(record.bmi, 1), record.bmi == null ? '' : bmiLabel(record.bmi))}
          ${tile('Body fat', pct(record.body_fat_pct), record.fat_mass_kg == null ? '' : `${kg(record.fat_mass_kg)} fat`)}
          ${tile('Lean mass', kg(record.lean_mass_kg), 'fat-free mass')}
          ${tile('Body water', pct(record.body_water_pct), record.body_water_l == null ? '' : `${fmtNum(record.body_water_l, 1)} L`)}
          ${tile('BMR', record.bmr_kcal == null ? '—' : html`${fmtNum(record.bmr_kcal, 1)}<small> kcal</small>`, 'energy at rest per day')}
        </div>
        ${missing ? html`<div class="form-note">Add your height and age in Settings → Profile to see body composition.</div>` : ''}
        <p class="tiny faint">Body composition is estimated from your weight, height, age and sex (Deurenberg, Watson and Mifflin–St Jeor equations) — this scale doesn't share its impedance over Bluetooth.${todays ? ` Logging replaces today's ${formatWeight(todays.weight_kg, unit)} entry.` : ''} ${state.goals?.is_custom ? 'Your custom targets stay as they are.' : 'Your calorie and macro targets will update to the new weight.'}</p>
        <button type="button" class="btn btn-ghost btn-sm" data-again style="align-self:flex-start">${icon('refresh', 16)} Measure again</button>
      </div>`);
    sheet.body.querySelector('[data-log]').addEventListener('click', () => {
      logWeight(today(), weightKg, { record });
      sheet.close();
      toast(`Logged ${formatWeight(weightKg, unit)}${record.heart_rate_bpm ? ` · ${record.heart_rate_bpm} bpm` : ''}.`, 'success');
    });
    sheet.body.querySelector('[data-again]').addEventListener('click', measure);
  };

  const showError = (err) => {
    sheet.setTitle('Measure with smart scale');
    setHTML(sheet.body, html`<div class="empty"><div class="empty-icon">${icon('scale', 24)}</div>
      <div class="empty-title">${err?.dismissed ? 'No scale selected' : "Couldn't read the scale"}</div>
      <div class="empty-sub">${err?.dismissed ? 'Step on the scale so it wakes up, then tap Try again and pick it from the list.' : err?.userMessage || 'Please try again.'}</div>
      <div class="row" style="justify-content:center"><button type="button" class="btn btn-primary btn-sm" data-retry>Try again</button>
      <button type="button" class="btn btn-secondary btn-sm" data-manual>Enter manually</button></div></div>`);
    sheet.body.querySelector('[data-retry]').addEventListener('click', measure);
    sheet.body.querySelector('[data-manual]').addEventListener('click', () => { sheet.close(); openWeightSheet(); });
  };

  function measure() {
    handle?.cancel();
    sheet.setTitle('Measure with smart scale');
    setHTML(sheet.body, html`
      <div class="weigh" aria-live="polite">
        <p class="weigh-status" id="sc-status">${STATUS.choose}</p>
        <div class="weigh-readout"><span class="weigh-value" id="sc-weight">0.00</span><span class="weigh-unit">${unit}</span></div>
        <div class="weigh-pulse" id="sc-hr" hidden><span class="heart" aria-hidden="true">♥</span><span id="sc-hr-val">—</span><span class="hr-unit">bpm</span></div>
        <div class="weigh-track" aria-hidden="true"><span id="sc-bar"></span></div>
        <p class="weigh-hint">Stay still — your heart rate is read a few seconds after the weight locks.</p>
      </div>`);
    const status = (key) => { const el = $('#sc-status', sheet.body); if (el) el.textContent = STATUS[key] || key; };
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
      status: (s) => { status(s); if (s === 'connected') bar(15); },
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

  measure();
  return sheet;
}

const bmiLabel = (b) => (b < 18.5 ? 'underweight' : b < 25 ? 'healthy range' : b < 30 ? 'overweight' : 'obese range');

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
    toast(`Weight saved: ${formatWeight(kg, unit)}.`, 'success');
  };
  sheet.foot.querySelector('[data-save]').addEventListener('click', save);
  sheet.foot.querySelector('[data-cancel]').addEventListener('click', () => sheet.close());
  $('#w-form', sheet.body).addEventListener('submit', (e) => { e.preventDefault(); save(); });
  return sheet;
}
