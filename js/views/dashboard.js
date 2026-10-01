// Dashboard: today's calories & macros, meals, quick add, water, weight, score, week chart.
import { html, setHTML, fmtInt, fmt1, fmtNum, today, addDays, relativeDayLabel, formatDay, parseISODate, MEAL_TYPES, debounce } from '../lib/utils.js';
import { sumNutrition, formatWeight, kgToLb } from '../lib/nutrition.js';
import { totalsByDate, dailyScore, weightChange, sortWeights } from '../lib/stats.js';
import { state, on, currentGoals, weightUnit } from '../store.js';
import { $, bindActions, toast, openSheet } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { ring, barChart, sparkline } from '../ui/charts.js';
import { cachedDay, fetchDay, fetchItemsRange, setWater, updateItem, deleteItem, logItems, activityCalories } from '../services/data.js';
import { openFoodLogger, openCamera, pickPhoto, openBarcode } from './food-logger.js';
import { openCoach } from './chat.js';
import { openCalendar } from './calendar.js';
import { openScale, openWeightSheet } from './weigh-in.js';

const GLASS_ML = 250;

export function mountDashboard(root) {
  const disposers = [];
  let weekDispose = null;
  let weekData = null;

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
    <div class="dash-grid">
      <div class="cards">
        <section class="card" id="d-hero" aria-label="Calories"></section>
        <div class="macros" id="d-macros"></div>
        <button type="button" class="launch-bar" data-action="describe">${icon('sparkles')}<span>Describe what you ate — AI works out the nutrition</span></button>
        <div class="quick-actions">
          <button type="button" class="qa" data-action="camera">${icon('camera')}Camera</button>
          <button type="button" class="qa" data-action="gallery">${icon('image')}Gallery</button>
          <button type="button" class="qa" data-action="barcode">${icon('barcode')}Barcode</button>
          <button type="button" class="qa" data-action="measure">${icon('scale')}Measure</button>
        </div>
        <section class="card" id="d-meals" aria-label="Meals"></section>
      </div>
      <div class="cards">
        <section class="card" id="d-score" aria-label="Daily score"></section>
        <section class="card" id="d-water" aria-label="Water"></section>
        <section class="card" id="d-weight" aria-label="Weight"></section>
        <section class="card" aria-label="Last 7 days">
          <div class="card-head"><h2 class="card-title">Last 7 days</h2><a class="small" href="#/progress">Progress →</a></div>
          <div id="d-week"><div class="skeleton" style="height:180px"></div></div>
        </section>
        <section class="card" aria-label="AI coach">
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
      setHTML($('#d-hero', root), html`<div class="skeleton" style="height:150px"></div>`);
      setHTML($('#d-meals', root), html`<div class="skeleton" style="height:120px"></div>`);
      return;
    }
    const totals = sumNutrition(day.items);
    const burned = day.activities.reduce((s, a) => s + activityCalories(a), 0);
    const addExercise = state.prefs?.exercise_mode === 'add';
    const budget = g.calories + (addExercise ? burned : 0);
    const remaining = budget - totals.calories;
    const over = remaining < 0;
    const pct = budget > 0 ? totals.calories / budget : 0;
    $('#d-sub', root).textContent = over
      ? `${fmtInt(-remaining)} kcal over ${state.date === today() ? "today's" : 'that day\'s'} target`
      : `${fmtInt(remaining)} kcal left ${state.date === today() ? 'today' : `on ${formatDay(state.date, { weekday: 'long' })}`}`;

    setHTML($('#d-hero', root), html`
      <div class="hero">
        <div class="ring ${over ? 'over' : ''}">${ring(pct)}
          <div class="ring-center"><div class="ring-value">${fmtInt(Math.min(999, pct * 100))}%</div><div class="ring-label">of target</div></div>
        </div>
        <div class="hero-body">
          <div class="eyebrow">${over ? 'Over target' : 'Calories remaining'}</div>
          <div class="hero-remaining ${over ? 'over' : ''}">${fmtInt(Math.abs(remaining))}</div>
          <div class="hero-caption">kcal ${over ? 'over' : 'left'} · target ${fmtInt(budget)} kcal${addExercise && burned ? ` (incl. ${fmtNum(burned, 1)} exercise)` : ''}</div>
          <div class="hero-stats">
            <div class="hero-stat"><div class="v">${fmtInt(totals.calories)}</div><div class="l">Eaten</div></div>
            <div class="hero-stat"><div class="v">${fmtNum(burned, 1)}</div><div class="l">Exercise</div></div>
            <div class="hero-stat"><div class="v">${fmtInt(g.calories)}</div><div class="l">Goal</div></div>
          </div>
        </div>
      </div>`);

    const macro = (label, color, v, goal) => {
      const p = goal > 0 ? v / goal : 0;
      return html`<div class="macro">
        <div class="macro-name"><i class="dot" style="background:var(${color})"></i>${label}</div>
        <div class="macro-val">${fmt1(v)}<small> / ${fmtInt(goal)} g</small></div>
        <div class="bar ${p > 1.15 && label !== 'Protein' && label !== 'Fiber' ? 'over' : ''}"><span style="width:${Math.min(100, p * 100)}%;background:var(${color})"></span></div>
        <div class="macro-sub">${goal - v >= 0 ? `${fmt1(goal - v)} g left` : `${fmt1(v - goal)} g over`}</div>
      </div>`;
    };
    setHTML($('#d-macros', root), html`
      ${macro('Protein', '--c-protein', totals.protein, g.protein)}
      ${macro('Carbs', '--c-carbs', totals.carbs, g.carbs)}
      ${macro('Fat', '--c-fat', totals.fat, g.fat)}
      ${macro('Fiber', '--c-fiber', totals.fiber, g.fiber)}`);

    // Meals grouped by type
    const groups = MEAL_TYPES.map((m) => ({ ...m, items: day.items.filter((i) => i.meal_type === m.id) }));
    const count = day.items.length;
    setHTML($('#d-meals', root), html`
      <div class="card-head"><h2 class="card-title">${state.date === today() ? "Today's meals" : `Meals · ${formatDay(state.date)}`}</h2><span class="small muted">${count} item${count === 1 ? '' : 's'}</span></div>
      ${count === 0 ? html`<div class="empty"><div class="empty-icon">🍽️</div><div class="empty-title">No meals logged${state.date === today() ? ' today' : ''}</div>
        <div class="empty-sub">Describe your meal, snap a photo or scan a barcode — AI estimates the nutrition.</div>
        <button type="button" class="btn btn-primary btn-sm" data-action="describe">${icon('plus', 16)} Add food</button></div>` : ''}
      ${count === 0 ? '' : groups.map((gr) => {
        const t = sumNutrition(gr.items);
        return html`<div class="meal-group">
          <div class="meal-head"><h3><span aria-hidden="true">${gr.icon}</span>${gr.label}</h3><span class="kcal">${gr.items.length ? `${fmtInt(t.calories)} kcal` : ''}</span></div>
          ${gr.items.map((it) => html`
            <div class="item ${it.pending ? 'pending' : ''}" role="button" tabindex="0" data-action="edit" data-id="${it.id}" aria-label="Edit ${it.food_name}">
              <div class="item-main">
                <div class="item-name">${it.food_name}</div>
                <div class="item-meta"><span>${fmt1(it.quantity)} ${it.unit}${it.grams && it.unit !== 'g' && it.unit !== 'ml' ? ` · ${fmtInt(it.grams)} g` : ''}</span>
                  <span>P ${fmt1(it.protein)} · C ${fmt1(it.carbs)} · F ${fmt1(it.fat)} · Fib ${fmt1(it.fiber)}</span>${it.pending ? html`<span>· saving…</span>` : ''}</div>
              </div>
              <div class="item-kcal">${fmtInt(it.calories)} <small>kcal</small></div>
            </div>`)}
          <button type="button" class="add-to-meal" data-action="add-to" data-meal="${gr.id}">+ Add to ${gr.label.toLowerCase()}</button>
        </div>`;
      })}`);

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
    const goalGlasses = state.prefs?.water_goal || 8;
    const glasses = day.water || 0;
    setHTML($('#d-water', root), html`
      <div class="card-head"><h2 class="card-title">${icon('drop', 18)} Water</h2><span class="small"><b>${glasses}</b> / ${goalGlasses} glasses · ${fmtInt(glasses * GLASS_ML)} ml</span></div>
      <div class="water-row">
        <button type="button" class="round-btn" data-action="water" data-delta="-1" aria-label="Remove a glass" ${glasses <= 0 ? 'disabled' : ''}>−</button>
        <div class="water-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${goalGlasses}" aria-valuenow="${glasses}" aria-label="Water"><span style="width:${Math.min(100, (glasses / goalGlasses) * 100)}%"></span></div>
        <button type="button" class="round-btn" data-action="water" data-delta="1" aria-label="Add a glass">+</button>
      </div>`);
  };

  const renderWeight = () => {
    const unit = weightUnit();
    const w = sortWeights(state.weights);
    const latest = w[w.length - 1];
    const ch = weightChange(w, 7);
    const target = state.profile?.target_weight_kg;
    const extra = latest ? [
      latest.body_fat_pct != null ? `${fmtNum(latest.body_fat_pct, 1)}% body fat` : null,
      latest.heart_rate_bpm ? `${latest.heart_rate_bpm} bpm` : null,
    ].filter(Boolean).join(' · ') : '';
    setHTML($('#d-weight', root), html`
      <div class="card-head"><h2 class="card-title">${icon('scale', 18)} Weight</h2>
        <div class="row"><button type="button" class="btn btn-primary btn-sm" data-action="measure">${icon('scale', 16)} Measure</button>
        <button type="button" class="btn btn-secondary btn-sm" data-action="log-weight">+ Log</button></div></div>
      ${latest ? html`<div class="row between">
        <div><div style="font-size:1.6rem;font-weight:800">${formatWeight(latest.weight_kg, unit)}</div>
          <div class="small muted">${ch ? `${ch.change > 0 ? '+' : ch.change < 0 ? '−' : '±'}${formatWeight(Math.abs(ch.change), unit)} vs ${formatDay(ch.from.recorded_on, { month: 'short', day: 'numeric' })}` : `Logged ${relativeDayLabel(latest.recorded_on).toLowerCase()}`}${target ? ` · target ${formatWeight(target, unit)}` : ''}</div>
          ${extra ? html`<div class="tiny faint">${extra}</div>` : ''}</div>
        ${sparkline(w.slice(-14).map((x) => (unit === 'lb' ? kgToLb(x.weight_kg) : x.weight_kg)))}
      </div>` : html`<p class="small muted">No weigh-ins yet. Measure with your smart scale or log your weight to track progress.</p>`}`);
  };

  const renderWeek = async () => {
    const end = state.date;
    const start = addDays(end, -6);
    const el = $('#d-week', root);
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

  // ── Actions ─────────────────────────────────────────────────────────
  disposers.push(bindActions(root, {
    prev: () => setDate(addDays(state.date, -1)),
    next: () => setDate(addDays(state.date, 1)),
    calendar: () => openCalendar({ selected: state.date, onPick: setDate }),
    describe: () => openFoodLogger({ tab: 'ai' }),
    camera: () => openCamera(),
    gallery: () => pickPhoto(),
    barcode: () => openBarcode(),
    measure: () => openScale(),
    'add-to': (el) => openFoodLogger({ tab: 'ai', mealType: el.dataset.meal }),
    edit: (el) => { const it = state.day?.items.find((x) => x.id === el.dataset.id); if (it) editItem(it); },
    water: (el) => { const n = (state.day?.water || 0) + Number(el.dataset.delta); if (n >= 0) setWater(state.date, n); },
    'log-weight': () => openWeightSheet(),
    review: () => openCoach({ mode: 'day_review' }),
    plan: () => openCoach({ mode: 'meal_plan' }),
    chat: () => openCoach({}),
    'retry-day': () => loadDay(),
    'retry-week': () => { weekData = null; renderWeek(); },
  }));
  root.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-action="edit"]')) { e.preventDefault(); e.target.click(); }
  });

  disposers.push(on('day', () => { renderDay(); renderWeek(); }));
  disposers.push(on('data-changed', refreshWeek));
  disposers.push(on('weights', renderWeight));
  disposers.push(on('account', () => { renderHeader(); renderDay(); renderWeight(); refreshWeek(); }));
  disposers.push(on('remote-day', (date) => { if (date === state.date) loadDay(); else refreshWeek(); }));

  renderWeight();
  loadDay();

  return () => { disposers.forEach((d) => d()); weekDispose?.(); };
}

// ── Edit item sheet ───────────────────────────────────────────────────────
/** Changes the amount (nutrition scales linearly from what was logged) or the meal. */
function editItem(item) {
  let meal = item.meal_type;
  const sheet = openSheet({ title: 'Edit entry', footer: true });
  setHTML(sheet.body, html`
    <div class="stack">
      <div><h3>${item.food_name}</h3><p class="small muted">${fmtInt(item.calories)} kcal · P ${fmt1(item.protein)} · C ${fmt1(item.carbs)} · F ${fmt1(item.fat)} · Fib ${fmt1(item.fiber)}</p></div>
      <div class="qty-row">
        <div class="field"><label for="e-qty">Amount</label><input class="input" id="e-qty" type="number" inputmode="decimal" min="0.1" step="any" value="${fmt1(item.quantity)}"></div>
        <div class="field"><label for="e-unit">Unit</label><input class="input" id="e-unit" value="${item.unit}" disabled></div>
      </div>
      <p class="small muted" id="e-preview" aria-live="polite"></p>
      <div class="chips" role="group" aria-label="Meal">${MEAL_TYPES.map((m) => html`<button type="button" class="chip" data-meal="${m.id}" aria-pressed="${m.id === meal}">${m.icon} ${m.label}</button>`)}</div>
    </div>`);
  setHTML(sheet.foot, html`<button type="button" class="btn btn-danger" data-del>${icon('trash', 16)} Delete</button><button type="button" class="btn btn-primary" data-save>Save</button>`);
  const qty = $('#e-qty', sheet.body);
  const compute = () => {
    const q = Number(qty.value);
    if (!(q > 0)) return null;
    const f = q / (Number(item.quantity) || 1);
    return { quantity: q, grams: item.grams ? item.grams * f : null, calories: item.calories * f, protein: item.protein * f, carbs: item.carbs * f, fat: item.fat * f, fiber: item.fiber * f };
  };
  const preview = () => {
    const n = compute();
    $('#e-preview', sheet.body).textContent = n ? `New total: ${fmtInt(n.calories)} kcal · P ${fmt1(n.protein)} g · C ${fmt1(n.carbs)} g · F ${fmt1(n.fat)} g · Fiber ${fmt1(n.fiber)} g` : 'Enter an amount greater than zero.';
  };
  qty.addEventListener('input', preview);
  sheet.body.addEventListener('click', (e) => {
    const m = e.target.closest('[data-meal]');
    if (!m) return;
    meal = m.dataset.meal;
    sheet.body.querySelectorAll('[data-meal]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.meal === meal)));
  });
  sheet.foot.querySelector('[data-save]').addEventListener('click', () => {
    const n = compute();
    if (!n) { toast('Enter an amount greater than zero.', 'error'); return; }
    updateItem(item, meal, n);
    sheet.close();
    toast('Entry updated.', 'success');
  });
  sheet.foot.querySelector('[data-del]').addEventListener('click', () => {
    deleteItem(item);
    sheet.close();
    toast(`Deleted ${item.food_name}.`, 'info', {
      action: 'Undo',
      onAction: () => logItems(item.meal_date, item.meal_type, [{ ...item, id: undefined }]),
    });
  });
  preview();
}
