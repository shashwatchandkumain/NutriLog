// Calories page: energy balance for the day, activity logging, and a 7-day balance.
import { html, setHTML, fmtInt, today, addDays, relativeDayLabel, dateRange } from '../lib/utils.js';
import { bmr as calcBmr, tdee as calcTdee, sumNutrition, ACTIVITY_LEVELS } from '../lib/nutrition.js';
import { totalsByDate } from '../lib/stats.js';
import { ACTIVITY_PRESETS, netActivityCalories } from '../lib/activity.js';
import { state, on, currentGoals } from '../store.js';
import { $, bindActions, toast, showError, withBusy, openSheet } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { cachedDay, fetchDay, fetchItemsRange, fetchActivitiesRange, logActivity, deleteActivity } from '../services/data.js';
import { analyzeActivity } from '../services/ai.js';

const KCAL_PER_KG_FAT = 7700;

function energy() {
  const p = state.profile || {};
  const b = calcBmr({ weightKg: Number(p.weight_kg), heightCm: Number(p.height_cm), age: Number(p.age), sex: p.sex });
  if (!b) return null;
  return { bmr: b, tdee: calcTdee(b, p.activity_level), sedentary: calcTdee(b, 'sedentary'), level: ACTIVITY_LEVELS[p.activity_level] || ACTIVITY_LEVELS.sedentary };
}

export function mountCalories(root) {
  const disposers = [];
  let preset = null;

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
          <div class="card-head"><h2 class="card-title">${icon('flame', 18)} Log activity</h2></div>
          <div class="chips" id="c-presets">${ACTIVITY_PRESETS.map((a) => html`<button type="button" class="chip" data-action="preset" data-id="${a.id}" aria-pressed="false">${a.emoji} ${a.name}</button>`)}</div>
          <form class="row" id="c-preset-form" style="margin-top:12px" hidden>
            <div class="input-group" style="max-width:170px"><input class="input" name="minutes" type="number" inputmode="numeric" min="1" max="600" placeholder="Minutes" aria-label="Duration in minutes" required><span class="input-suffix">min</span></div>
            <span class="small muted grow" id="c-preset-kcal"></span>
            <button class="btn btn-primary" type="submit">Log</button>
          </form>
          <div class="divider">or describe it</div>
          <form class="stack-sm" id="c-ai-form">
            <textarea class="textarea" name="text" maxlength="500" rows="2" placeholder="e.g. 45 min badminton and a 20 minute walk" aria-label="Describe your activity"></textarea>
            <button class="btn btn-secondary" type="submit">${icon('sparkles', 16)} Estimate with AI</button>
          </form>
        </section>
        <section class="card" id="c-list"></section>
      </div>
      <div class="cards">
        <section class="card" id="c-week"><div class="skeleton" style="height:140px"></div></section>
        <section class="card">
          <h2 class="card-title">How exercise is counted</h2>
          <p class="explain" style="margin-top:8px" id="c-mode-explain"></p>
          <a class="small" href="#/settings">Change in Settings →</a>
        </section>
      </div>
    </div>`);

  const weightKg = () => Number(state.profile?.weight_kg) || 70;

  const renderBalance = () => {
    const day = state.day;
    const e = energy();
    const d = state.date;
    $('#c-date', root).textContent = relativeDayLabel(d);
    $('#c-next', root).disabled = d >= today();
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
    const exercise = day.activities.reduce((s, a) => s + (Number(a.calories_burned) || 0), 0);
    const out = addMode ? e.sedentary + exercise : e.tdee;
    const balance = out - eaten;
    const logged = day.items.length > 0;
    setHTML($('#c-balance', root), html`
      <div class="card-head"><h2 class="card-title">Energy balance</h2><span class="tag ${balance >= 0 ? 'ok' : 'warn'}">${logged ? (balance >= 0 ? 'Deficit' : 'Surplus') : 'Nothing logged'}</span></div>
      <div class="tiles">
        <div class="tile"><div class="tile-label">BMR</div><div class="tile-value">${fmtInt(e.bmr)}<small> kcal</small></div></div>
        <div class="tile"><div class="tile-label">${addMode ? 'Base (sedentary)' : `TDEE · ${e.level.label}`}</div><div class="tile-value">${fmtInt(addMode ? e.sedentary : e.tdee)}<small> kcal</small></div></div>
        <div class="tile"><div class="tile-label">Exercise logged</div><div class="tile-value">${fmtInt(exercise)}<small> kcal</small></div><div class="tile-delta">${addMode ? 'added to energy out' : 'already in TDEE'}</div></div>
        <div class="tile"><div class="tile-label">Eaten</div><div class="tile-value">${fmtInt(eaten)}<small> kcal</small></div><div class="tile-delta">target ${fmtInt(currentGoals().calories + (addMode ? exercise : 0))}</div></div>
      </div>
      ${logged ? html`<p style="margin-top:14px"><b style="font-size:1.4rem">${fmtInt(Math.abs(balance))} kcal ${balance >= 0 ? 'deficit' : 'surplus'}</b>
        <span class="small muted"> ≈ ${Math.abs((balance / KCAL_PER_KG_FAT) * 1000).toFixed(0)} g body weight ${balance >= 0 ? 'lost' : 'gained'} (7,700 kcal ≈ 1 kg)</span></p>`
        : html`<p class="small muted" style="margin-top:12px">Log your meals to see the day's balance.</p>`}`);
  };

  const renderList = () => {
    const acts = state.day?.activities || [];
    const total = acts.reduce((s, a) => s + (Number(a.calories_burned) || 0), 0);
    setHTML($('#c-list', root), html`
      <div class="card-head"><h2 class="card-title">Activities</h2><span class="small muted">${acts.length ? `${fmtInt(total)} kcal` : ''}</span></div>
      ${acts.length ? acts.map((a) => html`
        <div class="item ${a.pending ? 'pending' : ''}">
          <div class="item-main"><div class="item-name">${a.name}</div><div class="item-meta">${a.duration_min} min${a.pending ? ' · saving…' : ''}</div></div>
          <div class="item-kcal">${fmtInt(a.calories_burned)} <small>kcal</small></div>
          <button type="button" class="icon-btn" data-action="del-act" data-id="${a.id}" aria-label="Delete ${a.name}">${icon('trash', 18)}</button>
        </div>`) : html`<div class="empty"><div class="empty-icon">🏃</div><div class="empty-title">No activities logged</div><div class="empty-sub">Pick an activity above or describe your workout.</div></div>`}`);
  };

  const renderWeek = async () => {
    const e = energy();
    const end = state.date, start = addDays(end, -6);
    const el = $('#c-week', root);
    if (!e) { setHTML(el, html`<h2 class="card-title">Last 7 days</h2><p class="small muted" style="margin-top:6px">Complete your profile to see weekly balance.</p>`); return; }
    try {
      const [items, acts] = await Promise.all([fetchItemsRange(start, end), fetchActivitiesRange(start, end)]);
      const byDay = totalsByDate(items);
      const loggedDays = dateRange(start, end).filter((d) => byDay[d]?.count);
      const addMode = state.prefs?.exercise_mode === 'add';
      const ex = acts.filter((a) => loggedDays.includes(a.activity_date)).reduce((s, a) => s + Number(a.calories_burned || 0), 0);
      const eaten = loggedDays.reduce((s, d) => s + byDay[d].calories, 0);
      const out = loggedDays.length * (addMode ? e.sedentary : e.tdee) + (addMode ? ex : 0);
      const bal = out - eaten;
      setHTML(el, html`
        <div class="card-head"><h2 class="card-title">Last 7 days</h2><span class="small muted">${loggedDays.length} logged day${loggedDays.length === 1 ? '' : 's'}</span></div>
        ${loggedDays.length ? html`<div class="tiles">
          <div class="tile"><div class="tile-label">Eaten</div><div class="tile-value">${fmtInt(eaten)}</div></div>
          <div class="tile"><div class="tile-label">Energy out</div><div class="tile-value">${fmtInt(out)}</div></div>
          <div class="tile"><div class="tile-label">${bal >= 0 ? 'Deficit' : 'Surplus'}</div><div class="tile-value">${fmtInt(Math.abs(bal))}</div><div class="tile-delta ${bal >= 0 ? 'good' : ''}">≈ ${Math.abs(bal / KCAL_PER_KG_FAT).toFixed(2)} kg</div></div>
        </div><p class="tiny faint" style="margin-top:8px">Only days with logged food are counted, so unlogged days don't look like a deficit.</p>`
          : html`<p class="small muted">No food logged in the last 7 days.</p>`}`);
    } catch (err) {
      console.error('[NutriLog] weekly balance', err);
      setHTML(el, html`<h2 class="card-title">Last 7 days</h2><p class="small muted">Couldn't load weekly data.</p>`);
    }
  };

  const loadDay = async () => {
    state.day = cachedDay(state.date);
    renderBalance(); renderList();
    try { const day = await fetchDay(state.date); state.day = day; renderBalance(); renderList(); } catch (e) { console.error('[NutriLog] calories day', e); }
    renderWeek();
  };

  const presetForm = $('#c-preset-form', root);
  const updatePresetKcal = () => {
    const m = Number(presetForm.minutes.value);
    $('#c-preset-kcal', root).textContent = preset && m > 0 ? `≈ ${fmtInt(netActivityCalories(preset.met, weightKg(), m))} kcal (MET ${preset.met})` : '';
  };
  presetForm.addEventListener('input', updatePresetKcal);
  presetForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const m = Number(presetForm.minutes.value);
    if (!preset || !(m > 0 && m <= 600)) { toast('Enter minutes between 1 and 600.', 'error'); return; }
    logActivity(state.date, { name: preset.name, duration_min: m, calories_burned: netActivityCalories(preset.met, weightKg(), m), source: 'preset' });
    toast(`${preset.name} logged.`, 'success');
    presetForm.reset(); presetForm.hidden = true; preset = null;
    root.querySelectorAll('[data-action="preset"]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
  });

  const aiForm = $('#c-ai-form', root);
  aiForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = aiForm.text.value.trim();
    if (!text) { toast('Describe your activity first.', 'error'); return; }
    withBusy(aiForm.querySelector('[type=submit]'), 'Estimating…', async () => {
      try {
        const items = await analyzeActivity(text);
        if (!items.length) { toast("Couldn't find an activity in that description.", 'error'); return; }
        reviewActivities(items, () => aiForm.reset());
      } catch (err) { showError(err, 'activity AI'); }
    });
  });

  disposers.push(bindActions(root, {
    prev: () => { state.date = addDays(state.date, -1); loadDay(); },
    next: () => { if (state.date < today()) { state.date = addDays(state.date, 1); loadDay(); } },
    preset: (el) => {
      preset = ACTIVITY_PRESETS.find((a) => a.id === el.dataset.id);
      root.querySelectorAll('[data-action="preset"]').forEach((b) => b.setAttribute('aria-pressed', String(b === el)));
      presetForm.hidden = false;
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
  disposers.push(on('account', () => { renderBalance(); renderWeek(); }));
  disposers.push(on('remote-day', (d) => { if (d === state.date) loadDay(); }));
  loadDay();
  return () => disposers.forEach((d) => d());
}

function reviewActivities(items, onDone) {
  const sheet = openSheet({ title: 'Add activities', footer: true });
  setHTML(sheet.body, html`<div class="stack-sm">${items.map((a) => html`
    <div class="item"><div class="item-main"><div class="item-name">${a.name}</div><div class="item-meta">${a.duration_min} min · MET ${a.met}</div></div><div class="item-kcal">${fmtInt(a.calories_burned)} <small>kcal</small></div></div>`)}
    <p class="tiny faint">Net calories above resting, based on your weight.</p></div>`);
  setHTML(sheet.foot, html`<button type="button" class="btn btn-secondary" data-cancel>Cancel</button><button type="button" class="btn btn-primary" data-ok>Add ${items.length}</button>`);
  sheet.foot.querySelector('[data-cancel]').addEventListener('click', () => sheet.close());
  sheet.foot.querySelector('[data-ok]').addEventListener('click', () => {
    for (const a of items) logActivity(state.date, { ...a, source: 'ai' });
    sheet.close(); onDone?.();
    toast(`${items.length} activit${items.length === 1 ? 'y' : 'ies'} logged.`, 'success');
  });
}
