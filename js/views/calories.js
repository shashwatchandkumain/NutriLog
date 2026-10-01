// Calories page: energy balance for the day, activity logging, and a 7-day balance.
// Burned calories always use the user's weight ON THAT DAY (latest weigh-in on/before it) and
// are shown unrounded to one decimal — a new weigh-in updates them immediately.
import { html, setHTML, fmtInt, fmtNum, today, addDays, relativeDayLabel, dateRange, formatDay } from '../lib/utils.js';
import { bmr as calcBmr, tdee as calcTdee, sumNutrition, ACTIVITY_LEVELS, KCAL_PER_KG, formatWeight, trimNumber } from '../lib/nutrition.js';
import { totalsByDate } from '../lib/stats.js';
import { ACTIVITY_PRESETS, netActivityCalories, treadmillMet, TREADMILL_RUN_KMH } from '../lib/activity.js';
import { state, on, currentGoals, weightUnit } from '../store.js';
import { $, bindActions, toast, showError, withBusy, openSheet } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { cachedDay, fetchDay, fetchItemsRange, fetchActivitiesRange, logActivity, deleteActivity, activityCalories, weightOnDate } from '../services/data.js';
import { analyzeActivity } from '../services/ai.js';

/** BMR and TDEE for a date, using the weight on that date. */
function energy(date) {
  const p = state.profile || {};
  const weightKg = weightOnDate(date);
  const b = calcBmr({ weightKg, heightCm: Number(p.height_cm), age: Number(p.age), sex: p.sex });
  if (!b) return null;
  return { weightKg, bmr: b, tdee: calcTdee(b, p.activity_level), sedentary: calcTdee(b, 'sedentary'), level: ACTIVITY_LEVELS[p.activity_level] || ACTIVITY_LEVELS.sedentary };
}

export function mountCalories(root) {
  const disposers = [];
  let preset = null;
  let runMode = null; // treadmill: null = decide by speed, or 'walk' | 'run'

  setHTML(root, html`
    <div class="page-head">
      <div><h1>Calories</h1><p class="small muted">Energy in vs. energy out</p></div>
      <div class="date-nav" role="group" aria-label="Choose day">
        <button class="icon-btn" type="button" data-action="prev" aria-label="Previous day">${icon('chevronLeft')}</button>
        <span class="date-label" id="c-date"></span>
        <button class="icon-btn" type="button" data-action="next" aria-label="Next day" id="c-next">${icon('chevronRight')}</button>
      </div>
    </div>
    <div class="dash-grid">
      <div class="cards">
        <section class="card" id="c-balance"></section>
        <section class="card">
          <div class="card-head"><h2 class="card-title">${icon('flame', 18)} Log activity</h2><span class="small muted" id="c-weight-note"></span></div>
          <div class="chips" id="c-presets">${ACTIVITY_PRESETS.map((a) => html`<button type="button" class="chip" data-action="preset" data-id="${a.id}" aria-pressed="false">${a.emoji} ${a.name}</button>`)}</div>
          <form class="stack-sm" id="c-preset-form" style="margin-top:12px" hidden novalidate>
            <div class="row wrap">
              <div class="input-group" style="max-width:150px"><input class="input" name="minutes" type="number" inputmode="numeric" min="1" max="600" placeholder="Minutes" aria-label="Duration in minutes" required><span class="input-suffix">min</span></div>
              <div class="input-group treadmill-only" style="max-width:150px"><input class="input" name="speed" type="number" inputmode="decimal" min="1" max="25" step="0.1" placeholder="Speed" aria-label="Speed in km/h"><span class="input-suffix">km/h</span></div>
              <div class="input-group treadmill-only" style="max-width:130px"><input class="input" name="incline" type="number" inputmode="decimal" min="0" max="40" step="0.5" placeholder="Incline" aria-label="Incline in percent" value="0"><span class="input-suffix">%</span></div>
              <div class="segmented treadmill-only" role="group" aria-label="Walking or running">
                <button type="button" data-run="walk" aria-pressed="false">Walk</button><button type="button" data-run="run" aria-pressed="false">Run</button>
              </div>
            </div>
            <div class="row between wrap">
              <span class="small muted grow" id="c-preset-kcal" aria-live="polite"></span>
              <button class="btn btn-primary" type="submit">Log</button>
            </div>
          </form>
          <div class="divider">or describe it</div>
          <form class="stack-sm" id="c-ai-form">
            <textarea class="textarea" name="text" maxlength="500" rows="2" placeholder="e.g. 30 min treadmill at 6 km/h, 2% incline and 20 min of weights" aria-label="Describe your activity"></textarea>
            <button class="btn btn-secondary" type="submit" style="align-self:flex-end">${icon('sparkles', 16)} Estimate with AI</button>
          </form>
        </section>
        <section class="card" id="c-list"></section>
      </div>
      <div class="cards">
        <section class="card" id="c-week"><div class="skeleton" style="height:140px"></div></section>
        <section class="card">
          <h2 class="card-title">How exercise is counted</h2>
          <p class="explain" style="margin-top:8px" id="c-mode-explain"></p>
          <p class="explain" style="margin-top:8px">Burned calories are <b>net</b>: (MET − 1) × your weight that day × hours. Resting energy is already part of your BMR, so it is not counted twice. Treadmill sessions use the ACSM equations for your speed and incline.</p>
          <a class="small" href="#/settings">Change in Settings →</a>
        </section>
      </div>
    </div>`);

  const unit = () => weightUnit();

  const renderBalance = () => {
    const day = state.day;
    const d = state.date;
    const e = energy(d);
    $('#c-date', root).textContent = relativeDayLabel(d);
    $('#c-next', root).disabled = d >= today();
    const w = weightOnDate(d);
    $('#c-weight-note', root).textContent = w ? `at ${formatWeight(w, unit())}` : '';
    const addMode = state.prefs?.exercise_mode === 'add';
    $('#c-mode-explain', root).textContent = addMode
      ? 'Logged workouts are added to your calorie budget. Your base target uses the sedentary multiplier so exercise is only counted once.'
      : `Your target already includes your usual activity (${e?.level.label.toLowerCase() || 'activity level'}). Logged workouts are shown for reference and not added again, so nothing is double-counted.`;
    if (!e) {
      setHTML($('#c-balance', root), html`<h2 class="card-title">Energy balance</h2><p class="small muted" style="margin-top:6px">Add your age, height and weight in Settings → Profile to see your energy balance.</p>`);
      return;
    }
    if (!day) { setHTML($('#c-balance', root), html`<div class="skeleton" style="height:140px"></div>`); return; }
    const eaten = sumNutrition(day.items).calories;
    const exercise = day.activities.reduce((s, a) => s + activityCalories(a), 0);
    const out = addMode ? e.sedentary + exercise : e.tdee;
    const balance = out - eaten;
    const logged = day.items.length > 0;
    setHTML($('#c-balance', root), html`
      <div class="card-head"><h2 class="card-title">Energy balance</h2><span class="tag ${balance >= 0 ? 'ok' : 'warn'}">${logged ? (balance >= 0 ? 'Deficit' : 'Surplus') : 'Nothing logged'}</span></div>
      <div class="tiles">
        <div class="tile"><div class="tile-label">BMR</div><div class="tile-value">${fmtNum(e.bmr, 1)}<small> kcal</small></div><div class="tile-delta">at ${formatWeight(e.weightKg, unit())}</div></div>
        <div class="tile"><div class="tile-label">${addMode ? 'Base (sedentary)' : `TDEE · ${e.level.label}`}</div><div class="tile-value">${fmtNum(addMode ? e.sedentary : e.tdee, 1)}<small> kcal</small></div></div>
        <div class="tile"><div class="tile-label">Exercise logged</div><div class="tile-value">${fmtNum(exercise, 1)}<small> kcal</small></div><div class="tile-delta">${addMode ? 'added to energy out' : 'already in TDEE'}</div></div>
        <div class="tile"><div class="tile-label">Eaten</div><div class="tile-value">${fmtInt(eaten)}<small> kcal</small></div><div class="tile-delta">target ${fmtInt(currentGoals().calories + (addMode ? exercise : 0))}</div></div>
      </div>
      ${logged ? html`<p style="margin-top:14px"><b style="font-size:1.4rem">${fmtNum(Math.abs(balance), 1)} kcal ${balance >= 0 ? 'deficit' : 'surplus'}</b>
        <span class="small muted"> ≈ ${fmtInt(Math.abs((balance / KCAL_PER_KG) * 1000))} g body weight ${balance >= 0 ? 'lost' : 'gained'} (7,700 kcal ≈ 1 kg)</span></p>`
        : html`<p class="small muted" style="margin-top:12px">Log your meals to see the day's balance.</p>`}`);
  };

  const renderList = () => {
    const acts = state.day?.activities || [];
    const total = acts.reduce((s, a) => s + activityCalories(a), 0);
    setHTML($('#c-list', root), html`
      <div class="card-head"><h2 class="card-title">Activities</h2><span class="small muted">${acts.length ? `${fmtNum(total, 1)} kcal` : ''}</span></div>
      ${acts.length ? acts.map((a) => {
        const w = a.met != null ? weightOnDate(a.activity_date) : null;
        return html`
        <div class="item ${a.pending ? 'pending' : ''}">
          <div class="item-main"><div class="item-name">${a.name}</div><div class="item-meta">${a.duration_min} min${a.met != null ? ` · MET ${trimNumber(a.met, 2)}` : ''}${w ? ` · at ${formatWeight(w, unit())}` : ''}${a.pending ? ' · saving…' : ''}</div></div>
          <div class="item-kcal">${fmtNum(activityCalories(a), 1)} <small>kcal</small></div>
          <button type="button" class="icon-btn" data-action="del-act" data-id="${a.id}" aria-label="Delete ${a.name}">${icon('trash', 18)}</button>
        </div>`;
      }) : html`<div class="empty"><div class="empty-icon">🏃</div><div class="empty-title">No activities logged</div><div class="empty-sub">Pick an activity above or describe your workout.</div></div>`}`);
  };

  const renderWeek = async () => {
    const end = state.date, start = addDays(end, -6);
    const el = $('#c-week', root);
    if (!energy(end)) { setHTML(el, html`<h2 class="card-title">Last 7 days</h2><p class="small muted" style="margin-top:6px">Complete your profile to see weekly balance.</p>`); return; }
    try {
      const [items, acts] = await Promise.all([fetchItemsRange(start, end), fetchActivitiesRange(start, end)]);
      const byDay = totalsByDate(items);
      const loggedDays = dateRange(start, end).filter((d) => byDay[d]?.count);
      const addMode = state.prefs?.exercise_mode === 'add';
      const ex = acts.filter((a) => loggedDays.includes(a.activity_date)).reduce((s, a) => s + activityCalories(a), 0);
      const eaten = loggedDays.reduce((s, d) => s + byDay[d].calories, 0);
      // Each day's energy out uses that day's weight.
      const base = loggedDays.reduce((s, d) => { const e = energy(d); return s + (e ? (addMode ? e.sedentary : e.tdee) : 0); }, 0);
      const out = base + (addMode ? ex : 0);
      const bal = out - eaten;
      setHTML(el, html`
        <div class="card-head"><h2 class="card-title">Last 7 days</h2><span class="small muted">${loggedDays.length} logged day${loggedDays.length === 1 ? '' : 's'}</span></div>
        ${loggedDays.length ? html`<div class="tiles">
          <div class="tile"><div class="tile-label">Eaten</div><div class="tile-value">${fmtInt(eaten)}</div></div>
          <div class="tile"><div class="tile-label">Energy out</div><div class="tile-value">${fmtNum(out, 1)}</div></div>
          <div class="tile"><div class="tile-label">${bal >= 0 ? 'Deficit' : 'Surplus'}</div><div class="tile-value">${fmtNum(Math.abs(bal), 1)}</div><div class="tile-delta ${bal >= 0 ? 'good' : ''}">≈ ${fmtNum(Math.abs(bal / KCAL_PER_KG), 2)} kg</div></div>
        </div><p class="tiny faint" style="margin-top:8px">Only days with logged food are counted, so unlogged days don't look like a deficit.</p>`
          : html`<p class="small muted">No food logged in the last 7 days.</p>`}`);
    } catch (err) {
      console.error('[NutriLog] weekly balance', err);
      setHTML(el, html`<h2 class="card-title">Last 7 days</h2><p class="small muted">Couldn't load weekly data.</p>`);
    }
  };

  const loadDay = async () => {
    const date = state.date;
    state.day = cachedDay(date);
    renderBalance(); renderList();
    try {
      const day = await fetchDay(date);
      if (date !== state.date) return;
      state.day = day;
      renderBalance(); renderList();
    } catch (e) { console.error('[NutriLog] calories day', e); }
    renderWeek();
  };

  // ── Preset / treadmill form ──────────────────────────────────────────
  const presetForm = $('#c-preset-form', root);
  const presetMet = () => {
    if (!preset) return null;
    if (!preset.treadmill) return preset.met;
    return treadmillMet({ speedKmh: Number(presetForm.speed.value), inclinePct: Number(presetForm.incline.value), mode: runMode });
  };
  const presetName = () => {
    if (!preset?.treadmill) return preset?.name || '';
    const speed = Number(presetForm.speed.value), incline = Number(presetForm.incline.value) || 0;
    const mode = runMode || (speed >= TREADMILL_RUN_KMH ? 'run' : 'walk');
    return `Treadmill ${mode === 'run' ? 'run' : 'walk'} · ${trimNumber(speed, 1)} km/h${incline ? ` · ${trimNumber(incline, 1)}% incline` : ''}`;
  };
  const updatePresetKcal = () => {
    const m = Number(presetForm.minutes.value);
    const met = presetMet();
    if (preset?.treadmill) {
      const speed = Number(presetForm.speed.value);
      const auto = speed >= TREADMILL_RUN_KMH ? 'run' : 'walk';
      root.querySelectorAll('[data-run]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.run === (runMode || auto))));
    }
    const w = weightOnDate(state.date);
    $('#c-preset-kcal', root).textContent = preset && met && m > 0 && w
      ? `≈ ${fmtNum(netActivityCalories(Math.round(met * 100) / 100, w, m), 1)} kcal · MET ${trimNumber(met, 2)} · at ${formatWeight(w, unit())}`
      : preset?.treadmill ? 'Enter minutes and speed.' : '';
  };
  presetForm.addEventListener('input', updatePresetKcal);
  presetForm.addEventListener('click', (e) => {
    const b = e.target.closest('[data-run]');
    if (!b) return;
    runMode = b.dataset.run;
    updatePresetKcal();
  });
  presetForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const m = Number(presetForm.minutes.value);
    if (!preset || !(m >= 1 && m <= 600)) { toast('Enter minutes between 1 and 600.', 'error'); return; }
    const met = presetMet();
    if (!met) { toast('Enter your treadmill speed in km/h.', 'error'); presetForm.speed.focus(); return; }
    const row = logActivity(state.date, { name: presetName(), duration_min: m, met, source: 'preset' });
    toast(`${row.name} logged: ${fmtNum(row.calories_burned, 1)} kcal.`, 'success');
    presetForm.reset(); presetForm.hidden = true; preset = null; runMode = null;
    root.querySelectorAll('[data-action="preset"]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
  });

  const aiForm = $('#c-ai-form', root);
  aiForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = aiForm.text.value.trim();
    if (!text) { toast('Describe your activity first.', 'error'); return; }
    withBusy(aiForm.querySelector('[type=submit]'), 'Estimating…', async () => {
      try {
        const date = state.date;
        const items = await analyzeActivity(text, weightOnDate(date));
        if (!items.length) { toast("Couldn't find an activity in that description.", 'error'); return; }
        reviewActivities(items, date, () => aiForm.reset());
      } catch (err) { showError(err, 'activity AI'); }
    });
  });

  disposers.push(bindActions(root, {
    prev: () => { state.date = addDays(state.date, -1); loadDay(); },
    next: () => { if (state.date < today()) { state.date = addDays(state.date, 1); loadDay(); } },
    preset: (el) => {
      preset = ACTIVITY_PRESETS.find((a) => a.id === el.dataset.id);
      runMode = null;
      root.querySelectorAll('[data-action="preset"]').forEach((b) => b.setAttribute('aria-pressed', String(b === el)));
      presetForm.hidden = false;
      presetForm.classList.toggle('is-treadmill', !!preset?.treadmill);
      presetForm.minutes.focus();
      updatePresetKcal();
    },
    'del-act': (el) => {
      const a = state.day?.activities.find((x) => x.id === el.dataset.id);
      if (a) { deleteActivity(a); toast(`Deleted ${a.name}.`); }
    },
  }));
  disposers.push(on('day', () => { renderBalance(); renderList(); }));
  disposers.push(on('data-changed', () => renderWeek()));
  disposers.push(on('weights', () => { renderBalance(); renderList(); updatePresetKcal(); renderWeek(); }));
  disposers.push(on('account', () => { renderBalance(); renderWeek(); }));
  disposers.push(on('remote-day', (d) => { if (d === state.date) loadDay(); }));
  loadDay();
  return () => disposers.forEach((d) => d());
}

function reviewActivities(items, date, onDone) {
  const w = weightOnDate(date);
  const unit = weightUnit();
  const kcal = (a) => (w ? netActivityCalories(a.met, w, a.duration_min) : Number(a.calories_burned) || 0);
  const sheet = openSheet({ title: 'Add activities', footer: true });
  setHTML(sheet.body, html`<div class="stack-sm">${items.map((a) => html`
    <div class="item"><div class="item-main"><div class="item-name">${a.name}</div><div class="item-meta">${a.duration_min} min · MET ${trimNumber(a.met, 2)}</div></div><div class="item-kcal">${fmtNum(kcal(a), 1)} <small>kcal</small></div></div>`)}
    <p class="tiny faint">Net calories above resting, for your weight on ${formatDay(date)}${w ? ` (${formatWeight(w, unit)})` : ''}.</p></div>`);
  setHTML(sheet.foot, html`<button type="button" class="btn btn-secondary" data-cancel>Cancel</button><button type="button" class="btn btn-primary" data-ok>Add ${items.length}</button>`);
  sheet.foot.querySelector('[data-cancel]').addEventListener('click', () => sheet.close());
  sheet.foot.querySelector('[data-ok]').addEventListener('click', () => {
    for (const a of items) logActivity(date, { name: a.name, duration_min: a.duration_min, met: a.met, source: 'ai' });
    sheet.close(); onDone?.();
    toast(`${items.length} activit${items.length === 1 ? 'y' : 'ies'} logged.`, 'success');
  });
}
