// Activity: energy balance for the day (eaten vs. burned), activity logging and a 7-day
// balance. Burned calories always use the weight ON THAT DAY and are shown to one decimal;
// a new weigh-in updates them immediately. Exercise is never counted twice: it is either part
// of the activity level (default) or added to the day's budget (Settings → Exercise calories).
import { html, setHTML, fmtInt, fmtNum, today, addDays, relativeDayLabel, dateRange } from '../lib/utils.js';
import { bmr as calcBmr, tdee as calcTdee, sumNutrition, ACTIVITY_LEVELS, KCAL_PER_KG, formatWeight, trimNumber } from '../lib/nutrition.js';
import { totalsByDate } from '../lib/stats.js';
import { state, on, currentGoals, weightUnit } from '../store.js';
import { $, bindActions, toast } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { cachedDay, fetchDay, fetchItemsRange, fetchActivitiesRange, deleteActivity, activityCalories, weightOnDate } from '../services/data.js';
import { renderActivityForm } from './activity-log.js';

/** BMR and TDEE for a date, using the weight on that date. */
function energy(date) {
  const p = state.profile || {};
  const weightKg = weightOnDate(date);
  const b = calcBmr({ weightKg, heightCm: Number(p.height_cm), age: Number(p.age), sex: p.sex });
  if (!b) return null;
  return { weightKg, bmr: b, tdee: calcTdee(b, p.activity_level), sedentary: calcTdee(b, 'sedentary'), level: ACTIVITY_LEVELS[p.activity_level] || ACTIVITY_LEVELS.sedentary };
}

export function mountActivity(root) {
  const disposers = [];

  setHTML(root, html`
    <div class="page-head">
      <div><h1>Activity</h1><p class="small muted">Energy in vs. energy out</p></div>
      <div class="date-nav" role="group" aria-label="Choose day">
        <button class="icon-btn" type="button" data-action="prev" aria-label="Previous day">${icon('chevronLeft')}</button>
        <span class="date-label" id="c-date"></span>
        <button class="icon-btn" type="button" data-action="next" aria-label="Next day" id="c-next">${icon('chevronRight')}</button>
      </div>
    </div>
    <div class="dash-grid">
      <div class="cards">
        <section class="card" id="c-balance" aria-label="Energy balance"></section>
        <section class="card" aria-label="Log activity">
          <div class="card-head"><h2 class="card-title">${icon('flame', 18)} Log activity</h2><span class="small muted" id="c-weight-note"></span></div>
          <div id="c-form"></div>
        </section>
        <section class="card" id="c-list" aria-label="Activities"></section>
      </div>
      <div class="cards">
        <section class="card" id="c-week" aria-label="Last 7 days"><div class="skeleton" style="height:140px"></div></section>
        <section class="card">
          <h2 class="card-title">How exercise is counted</h2>
          <p class="explain" style="margin-top:8px" id="c-mode-explain"></p>
          <p class="explain" style="margin-top:8px">Burned calories are <b>net</b>: (MET − 1) × your weight that day × hours. Resting energy is already part of your BMR, so it is not counted twice. Treadmill sessions use the ACSM equations for your speed and incline; intensities use Compendium of Physical Activities values.</p>
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
      ? 'Logged workouts are added to your calorie target for that day. Your base target uses the sedentary multiplier so exercise is only counted once.'
      : `Your calorie target already includes your usual activity (${e?.level.label.toLowerCase() || 'activity level'}). Logged workouts are shown for reference and not added again, so nothing is double-counted.`;
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
        <div class="tile"><div class="tile-label">Activity calories</div><div class="tile-value">${fmtNum(exercise, 1)}<small> kcal</small></div><div class="tile-delta">${addMode ? 'added to energy out' : 'already in TDEE'}</div></div>
        <div class="tile"><div class="tile-label">Eaten</div><div class="tile-value">${fmtInt(eaten)}<small> kcal</small></div><div class="tile-delta">daily target ${fmtInt(currentGoals().calories + (addMode ? exercise : 0))}</div></div>
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
          <div class="item-main"><div class="item-name">${a.name}</div><div class="item-meta">${a.duration_min} min${a.met != null ? ` · MET ${trimNumber(a.met, 2)}` : ' · entered calories'}${w ? ` · at ${formatWeight(w, unit())}` : ''}${a.source === 'ai' ? ' · AI estimate' : ''}${a.pending ? ' · saving…' : ''}</div></div>
          <div class="item-kcal">${fmtNum(activityCalories(a), 1)} <small>kcal</small></div>
          <button type="button" class="icon-btn" data-action="del-act" data-id="${a.id}" aria-label="Delete ${a.name}">${icon('trash', 18)}</button>
        </div>`;
      }) : html`<div class="empty"><div class="empty-icon">🏃</div><div class="empty-title">No activities logged</div><div class="empty-sub">Pick an activity above, enter calories from your watch, or describe your workout.</div></div>`}`);
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
    } catch (e) { console.error('[NutriLog] activity day', e); }
    renderWeek();
  };

  const refreshEstimate = renderActivityForm($('#c-form', root), { getDate: () => state.date });

  disposers.push(bindActions(root, {
    prev: () => { state.date = addDays(state.date, -1); loadDay(); refreshEstimate(); },
    next: () => { if (state.date < today()) { state.date = addDays(state.date, 1); loadDay(); refreshEstimate(); } },
    'del-act': (el) => {
      const a = state.day?.activities.find((x) => x.id === el.dataset.id);
      if (a) { deleteActivity(a); toast(`Deleted ${a.name}.`); }
    },
  }));
  disposers.push(on('day', () => { renderBalance(); renderList(); }));
  disposers.push(on('data-changed', () => renderWeek()));
  disposers.push(on('weights', () => { renderBalance(); renderList(); refreshEstimate(); renderWeek(); }));
  disposers.push(on('account', () => { renderBalance(); renderWeek(); }));
  disposers.push(on('remote-day', (d) => { if (d === state.date) loadDay(); }));
  loadDay();
  return () => disposers.forEach((d) => d());
}
