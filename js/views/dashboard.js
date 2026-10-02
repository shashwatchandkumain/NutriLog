// Dashboard: the daily loop — calories left, macros, quick actions, meals, water, weight,
// activity, score, the last 7 days and the AI coach. One column on phones, two on tablets and
// small laptops, three on wide screens (see .dash in app.css).
import { html, setHTML, fmtInt, fmt1, fmtNum, formatVolume, today, addDays, relativeDayLabel, formatDay, parseISODate, debounce } from '../lib/utils.js';
import { sumNutrition, formatWeight, kgToLb } from '../lib/nutrition.js';
import { totalsByDate, dailyScore, weightChange, sortWeights } from '../lib/stats.js';
import { state, on, currentGoals, weightUnit, waterGoalMl } from '../store.js';
import { $, bindActions, toast, openSheet } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { ring, barChart, sparkline } from '../ui/charts.js';
import { cachedDay, fetchDay, fetchItemsRange, addWater, setWater, activityCalories } from '../services/data.js';
import { openFoodLogger, openCamera, openBarcode } from './food-logger.js';
import { mealsView, bindMealActions, loadYesterday } from './meals.js';
import { openCoach, openCalendar, openScale, openWeightSheet, openActivityLogger, openTargetsExplainer } from './lazy.js';

const WATER_STEPS = [250, 500, 750, 1000];

export function mountDashboard(root) {
  const disposers = [];
  let weekDispose = null;
  let weekData = null;
  let yesterday = null;

  const greeting = () => {
    const h = new Date().getHours();
    const part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    const name = state.profile?.display_name;
    return name ? `${part}, ${name}` : part;
  };

  setHTML(root, html`
    <div class="page-head">
      <div><h1 id="d-greet">${greeting()}</h1><p class="small muted" id="d-sub"></p></div>
      <div class="date-nav" role="group" aria-label="Choose day">
        <button class="icon-btn" type="button" data-action="prev" aria-label="Previous day">${icon('chevronLeft')}</button>
        <button class="date-label" type="button" data-action="calendar" id="d-date" aria-label="Open calendar"></button>
        <button class="icon-btn" type="button" data-action="next" aria-label="Next day" id="d-next">${icon('chevronRight')}</button>
      </div>
    </div>
    <div id="d-banners"></div>
    <div class="dash">
      <div class="dash-col">
        <section class="card hero-card" id="d-hero" aria-label="Calories"></section>
        <section class="card" id="d-macros" aria-label="Macros"></section>
        <section class="card" id="d-score" aria-label="Daily score"></section>
      </div>
      <div class="dash-col">
        <section class="quick" id="d-quick" aria-label="Quick actions">
          <button type="button" class="qa primary" data-action="log">${icon('plus')}<span>Log food</span></button>
          <button type="button" class="qa" data-action="camera">${icon('camera')}<span>AI food scan</span></button>
          <button type="button" class="qa" data-action="barcode">${icon('barcode')}<span>Scan barcode</span></button>
          <button type="button" class="qa" data-action="measure">${icon('scale')}<span>Measure weight</span></button>
          <button type="button" class="qa" data-action="water-quick">${icon('drop')}<span>Add water</span></button>
          <button type="button" class="qa" data-action="activity">${icon('activity')}<span>Log activity</span></button>
        </section>
        <section class="card" id="d-meals" aria-label="Meals"></section>
      </div>
      <div class="dash-col">
        <section class="card" id="d-water" aria-label="Water"></section>
        <section class="card" id="d-weight" aria-label="Weight"></section>
        <section class="card" id="d-activity" aria-label="Activity"></section>
        <section class="card" id="d-week" aria-label="Last 7 days">
          <div class="card-head"><h2 class="card-title">Last 7 days</h2><a class="small" href="#/progress">Progress →</a></div>
          <div id="d-week-chart"><div class="skeleton" style="height:180px"></div></div>
        </section>
        <section class="card" id="d-coach" aria-label="AI coach">
          <div class="card-head"><h2 class="card-title">${icon('sparkles', 18)} Nutri AI</h2></div>
          <div class="stack-sm">
            <button type="button" class="btn btn-secondary btn-block" data-action="review">Review my day</button>
            <button type="button" class="btn btn-secondary btn-block" data-action="plan">Suggest what to eat next</button>
            <button type="button" class="btn btn-ghost btn-block" data-action="chat">Ask a question</button>
          </div>
        </section>
      </div>
    </div>`);

  // ── Rendering pieces ─────────────────────────────────────────────────
  const renderHeader = () => {
    const d = state.date;
    $('#d-date', root).textContent = d === today() ? `Today · ${formatDay(d, { month: 'short', day: 'numeric' })}` : relativeDayLabel(d);
    $('#d-next', root).disabled = d >= today();
    $('#d-greet', root).textContent = greeting();
    const banners = $('#d-banners', root);
    if (state.user?.user_metadata?.needs_password) {
      setHTML(banners, html`<div class="banner"><span aria-hidden="true">🔑</span><div class="grow"><b>Create a password</b>So you can log in on your other devices.</div><a class="btn btn-primary btn-sm" href="#/set-password">Set password</a></div>`);
    } else banners.textContent = '';
  };

  const renderDay = () => {
    const day = state.day;
    const g = currentGoals();
    if (!day) {
      for (const id of ['#d-hero', '#d-macros', '#d-meals']) setHTML($(id, root), html`<div class="skeleton" style="height:${id === '#d-meals' ? 160 : 120}px"></div><p class="tiny faint" style="margin-top:8px">Loading today's nutrition…</p>`);
      return;
    }
    const totals = sumNutrition(day.items);
    const burned = day.activities.reduce((s, a) => s + activityCalories(a), 0);
    const addExercise = state.prefs?.exercise_mode === 'add';
    const budget = g.calories + (addExercise ? burned : 0);
    const remaining = budget - totals.calories;
    const over = remaining < 0;
    const pct = budget > 0 ? totals.calories / budget : 0;
    const isToday = state.date === today();
    $('#d-sub', root).textContent = `${formatDay(state.date, { weekday: 'long', month: 'long', day: 'numeric' })} · ${fmtInt(totals.calories)} of ${fmtInt(budget)} kcal${day.items.length ? ` · ${day.items.length} food${day.items.length === 1 ? '' : 's'}` : ''}`;

    setHTML($('#d-hero', root), html`
      <div class="hero">
        <div class="ring ${over ? 'over' : ''}">${ring(pct)}
          <div class="ring-center"><div class="ring-value">${fmtInt(Math.min(999, pct * 100))}%</div><div class="ring-label">of target</div></div>
        </div>
        <div class="hero-body">
          <div class="eyebrow">${over ? 'Over target' : 'Calories remaining'}</div>
          <div class="hero-remaining ${over ? 'over' : ''}">${over ? '+' : ''}${fmtInt(Math.abs(remaining))}<small> kcal${over ? ' over' : ''}</small></div>
          <div class="hero-stats">
            <div class="hero-stat"><div class="v">${fmtInt(totals.calories)}</div><div class="l">Consumed</div></div>
            <div class="hero-stat"><div class="v">${over ? '0' : fmtInt(remaining)}</div><div class="l">Remaining</div></div>
            <div class="hero-stat"><div class="v">${fmtInt(budget)}</div><div class="l">Target</div></div>
          </div>
          <p class="hero-caption">${burned ? `${fmtNum(burned, 1)} kcal exercise ${addExercise ? 'added to today’s target' : 'already counted in your activity level'} · ` : ''}<button type="button" class="link-btn" data-action="explain">How is this calculated?</button></p>
        </div>
      </div>`);

    const macro = (label, color, v, goal, capIsLimit) => {
      const p = goal > 0 ? v / goal : 0;
      const overLimit = capIsLimit && p > 1.15;
      return html`<div class="macro">
        <div class="macro-name"><i class="dot" style="background:var(${color})"></i>${label}<span class="macro-pct">${fmtInt(p * 100)}%</span></div>
        <div class="macro-val">${fmt1(v)}<small> / ${fmtInt(goal)} g</small></div>
        <div class="bar ${overLimit ? 'over' : ''}" role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="${Math.round(goal)}" aria-valuenow="${Math.round(v)}"><span style="width:${Math.min(100, p * 100)}%;background:var(${color})"></span></div>
        <div class="macro-sub">${goal - v >= 0 ? `${fmt1(goal - v)} g left` : `${fmt1(v - goal)} g over${overLimit ? ' ⚠' : ''}`}</div>
      </div>`;
    };
    setHTML($('#d-macros', root), html`
      <div class="card-head"><h2 class="card-title">Macros</h2><span class="small muted">${isToday ? 'today' : formatDay(state.date, { month: 'short', day: 'numeric' })}</span></div>
      <div class="macros">
        ${macro('Protein', '--c-protein', totals.protein, g.protein, false)}
        ${macro('Carbs', '--c-carbs', totals.carbs, g.carbs, true)}
        ${macro('Fat', '--c-fat', totals.fat, g.fat, true)}
        ${macro('Fiber', '--c-fiber', totals.fiber, g.fiber, false)}
      </div>`);

    // Meals
    const count = day.items.length;
    setHTML($('#d-meals', root), html`
      <div class="card-head"><h2 class="card-title">${isToday ? "Today's meals" : `Meals · ${formatDay(state.date)}`}</h2><a class="small" href="#/food">Food →</a></div>
      ${count === 0 ? html`<div class="empty"><div class="empty-icon">🍽️</div><div class="empty-title">No meals logged${isToday ? ' today' : ''}</div>
        <div class="empty-sub">Describe your meal, snap a photo or scan a barcode — AI estimates the nutrition and you confirm it.</div>
        <button type="button" class="btn btn-primary btn-sm" data-action="log">${icon('plus', 16)} Log your first meal</button></div>` : ''}
      ${mealsView(day, state.date, { yesterday })}`);

    // Score
    const score = dailyScore(totals, g, count);
    setHTML($('#d-score', root), html`
      <div class="score">
        <div class="score-num">${score ? score.score : '—'}<small>/ 100</small></div>
        <div class="grow"><div class="eyebrow">Daily score</div>
          <div style="font-weight:700">${score ? score.grade : 'Log a meal to get a score'}</div>
          ${score ? html`<div class="score-factors">${score.factors.map((f) => html`<span class="tag ${f.ok ? 'ok' : ''}">${f.ok ? '✓' : '·'} ${f.label}</span>`)}</div>` : ''}
        </div>
      </div>`);

    // Water
    const goalMl = waterGoalMl();
    const ml = Number(day.water) || 0;
    setHTML($('#d-water', root), html`
      <div class="card-head"><h2 class="card-title">${icon('drop', 18)} Water</h2><span class="small"><b>${formatVolume(ml)}</b> / ${formatVolume(goalMl)}</span></div>
      <div class="water-bar" role="progressbar" aria-label="Water" aria-valuemin="0" aria-valuemax="${goalMl}" aria-valuenow="${ml}"><span style="width:${Math.min(100, (ml / goalMl) * 100)}%"></span></div>
      <div class="water-steps">
        ${WATER_STEPS.map((v) => html`<button type="button" class="btn btn-secondary btn-sm" data-action="water" data-ml="${v}">+${formatVolume(v)}</button>`)}
        <button type="button" class="btn btn-ghost btn-sm" data-action="water-custom">Custom</button>
        <button type="button" class="icon-btn" data-action="water" data-ml="-250" aria-label="Remove 250 ml" ${ml <= 0 ? 'disabled' : ''}>${icon('minus', 18)}</button>
      </div>`);

    // Activity
    const acts = day.activities;
    setHTML($('#d-activity', root), html`
      <div class="card-head"><h2 class="card-title">${icon('activity', 18)} Activity</h2><button type="button" class="btn btn-secondary btn-sm" data-action="activity">+ Log</button></div>
      ${acts.length ? html`<div class="stack-sm">${acts.slice(0, 3).map((a) => html`<div class="row between small"><span>${a.name} · ${a.duration_min} min</span><b>${fmtNum(activityCalories(a), 1)} kcal</b></div>`)}
        ${acts.length > 3 ? html`<a class="small" href="#/activity">+${acts.length - 3} more</a>` : ''}</div>
        <p class="tiny faint" style="margin-top:8px">${fmtNum(burned, 1)} kcal burned · ${addExercise ? 'added to your target today' : 'already part of your activity level, not added again'}.</p>`
      : html`<p class="small muted">No activity logged${isToday ? ' today' : ''}. Log a workout to see the calories it burned.</p>`}`);
  };

  const renderWeight = () => {
    const unit = weightUnit();
    const w = sortWeights(state.weights);
    const latest = w[w.length - 1];
    const ch = weightChange(w, 7);
    const target = state.profile?.target_weight_kg;
    const extra = latest ? [
      latest.body_fat_pct != null ? `${fmtNum(latest.body_fat_pct, 1)}% body fat (est.)` : null,
      latest.heart_rate_bpm ? `${latest.heart_rate_bpm} bpm` : null,
    ].filter(Boolean).join(' · ') : '';
    setHTML($('#d-weight', root), html`
      <div class="card-head"><h2 class="card-title">${icon('scale', 18)} Weight</h2>
        <div class="row"><button type="button" class="btn btn-primary btn-sm" data-action="measure">${icon('scale', 16)} Measure</button>
        <button type="button" class="btn btn-secondary btn-sm" data-action="log-weight">+ Log</button></div></div>
      ${latest ? html`<div class="row between">
        <div><div class="big-number">${formatWeight(latest.weight_kg, unit)}</div>
          <div class="small muted">${ch ? `${ch.change > 0 ? '+' : ch.change < 0 ? '−' : '±'}${formatWeight(Math.abs(ch.change), unit)} vs ${formatDay(ch.from.recorded_on, { month: 'short', day: 'numeric' })}` : `Logged ${relativeDayLabel(latest.recorded_on).toLowerCase()}`}${target ? ` · goal ${formatWeight(target, unit)}` : ''}</div>
          ${extra ? html`<div class="tiny faint">${extra}</div>` : ''}</div>
        ${sparkline(w.slice(-14).map((x) => (unit === 'lb' ? kgToLb(x.weight_kg) : x.weight_kg)))}
      </div>` : html`<div class="empty compact"><div class="empty-title">No weigh-ins yet</div><div class="empty-sub">Measure with your smart scale or log your weight to track progress.</div></div>`}`);
  };

  const renderWeek = async () => {
    const end = state.date;
    const start = addDays(end, -6);
    const el = $('#d-week-chart', root);
    try {
      if (!weekData || weekData.end !== end) {
        const rows = await fetchItemsRange(start, end);
        weekData = { end, totals: totalsByDate(rows) };
      }
      const g = currentGoals();
      const data = [];
      for (let i = 0; i < 7; i++) {
        const d = addDays(start, i);
        // Use the live day for the selected date so the chart always matches the dashboard.
        const v = d === state.date && state.day ? sumNutrition(state.day.items).calories : weekData.totals[d]?.calories || 0;
        const dt = parseISODate(d);
        data.push({ key: d, label: dt.toLocaleDateString(undefined, { weekday: 'short' }), sub: String(dt.getDate()), value: v, className: v > g.calories * 1.05 ? 'over' : '', title: formatDay(d) });
      }
      weekDispose?.();
      if (!data.some((d) => d.value > 0)) { setHTML(el, html`<div class="chart-empty">No meals logged in these 7 days yet.</div>`); return; }
      weekDispose = barChart(el, data, { goal: g.calories, unit: 'kcal', activeKey: state.date, onSelect: (d) => setDate(d), ariaLabel: 'Calories for the last 7 days' });
    } catch (e) {
      console.error('[NutriLog] week chart', e);
      setHTML(el, html`<div class="chart-empty">Couldn't load the chart. <button type="button" class="link-btn" data-action="retry-week">Retry</button></div>`);
    }
  };
  const refreshWeek = debounce(() => { weekData = null; renderWeek(); }, 600);

  // ── Data loading ────────────────────────────────────────────────────
  const loadDay = async () => {
    const date = state.date;
    state.day = cachedDay(date);
    renderHeader(); renderDay();
    yesterday = null;
    if (date === today()) loadYesterday(date, (y) => { if (date === state.date) { yesterday = y; renderDay(); } });
    try {
      const day = await fetchDay(date);
      if (date !== state.date) return;
      state.day = day;
      renderDay();
    } catch (e) {
      if (!state.day) {
        setHTML($('#d-meals', root), html`<div class="error-state"><div class="empty-title">Couldn't load your meals</div><p class="small muted">${navigator.onLine ? 'Something went wrong. Please try again.' : "You're offline."}</p><button type="button" class="btn btn-secondary btn-sm" data-action="retry-day">Retry</button></div>`);
        setHTML($('#d-hero', root), html`<p class="muted small">Totals will appear once your meals load.</p>`);
      }
      console.error('[NutriLog] load day', e);
    }
    renderWeek();
  };

  const setDate = (d) => {
    if (d > today()) return;
    state.date = d;
    loadDay();
  };

  const water = (delta) => {
    const date = state.date;
    const before = Number(state.day?.water) || 0;
    const now = addWater(date, delta);
    if (delta > 0) toast(`${formatVolume(delta)} water logged ✓ · ${formatVolume(now)} total`, 'success', { action: 'Undo', onAction: () => setWater(date, before) });
  };

  // ── Actions ─────────────────────────────────────────────────────────
  disposers.push(bindActions(root, {
    prev: () => setDate(addDays(state.date, -1)),
    next: () => setDate(addDays(state.date, 1)),
    calendar: () => openCalendar({ selected: state.date, onPick: setDate }),
    log: () => openFoodLogger(),
    camera: () => openCamera(),
    barcode: () => openBarcode(),
    measure: () => openScale(),
    'log-weight': () => openWeightSheet(),
    activity: () => openActivityLogger({ date: state.date }),
    'water-quick': () => water(250),
    water: (el) => water(Number(el.dataset.ml)),
    'water-custom': () => customWater((ml) => water(ml)),
    explain: () => openTargetsExplainer(),
    review: () => openCoach({ mode: 'day_review' }),
    plan: () => openCoach({ mode: 'meal_plan' }),
    chat: () => openCoach({}),
    'retry-day': () => loadDay(),
    'retry-week': () => { weekData = null; renderWeek(); },
  }));
  disposers.push(bindMealActions(root, { getDay: () => state.day, getDate: () => state.date, getYesterday: () => yesterday }));

  disposers.push(on('day', () => { renderDay(); renderWeek(); }));
  disposers.push(on('data-changed', refreshWeek));
  disposers.push(on('weights', () => { renderWeight(); renderDay(); }));
  disposers.push(on('favorites', renderDay));
  disposers.push(on('account', () => { renderHeader(); renderDay(); renderWeight(); refreshWeek(); }));
  disposers.push(on('remote-day', (date) => { if (date === state.date) loadDay(); else refreshWeek(); }));

  renderWeight();
  loadDay();

  return () => { disposers.forEach((d) => d()); weekDispose?.(); };
}

/** Asks for a custom amount of water in ml. */
function customWater(onAdd) {
  const sheet = openSheet({ title: 'Add water', footer: true });
  setHTML(sheet.body, html`<form class="stack" id="cw-form" novalidate>
    <div class="field"><label for="cw-ml">Amount</label><div class="input-group"><input class="input" id="cw-ml" type="number" inputmode="numeric" min="10" max="5000" step="10" value="330"><span class="input-suffix">ml</span></div></div>
    <p class="hint">A glass is about 250 ml, a bottle 500 ml or 1 L.</p></form>`);
  setHTML(sheet.foot, html`<button type="button" class="btn btn-secondary" data-cancel>Cancel</button><button type="button" class="btn btn-primary" data-save>Add</button>`);
  const save = () => {
    const ml = Math.round(Number($('#cw-ml', sheet.body).value));
    if (!(ml >= 10 && ml <= 5000)) { toast('Enter an amount between 10 and 5,000 ml.', 'error'); return; }
    sheet.close();
    onAdd(ml);
  };
  sheet.foot.querySelector('[data-save]').addEventListener('click', save);
  sheet.foot.querySelector('[data-cancel]').addEventListener('click', () => sheet.close());
  $('#cw-form', sheet.body).addEventListener('submit', (e) => { e.preventDefault(); save(); });
}
