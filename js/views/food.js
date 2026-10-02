// Food: the day's nutrition, every way to log food, quick re-logging of the user's own foods
// (favorites first, then recent), and the day's meals with edit / duplicate / repeat.
import { html, setHTML, fmtInt, fmt1, today, addDays, relativeDayLabel, formatDay, MEAL_TYPES } from '../lib/utils.js';
import { sumNutrition } from '../lib/nutrition.js';
import { withFavorites, scaleFood } from '../lib/food-library.js';
import { state, on, currentGoals } from '../store.js';
import { $, bindActions, toast } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { cachedDay, fetchDay, fetchRecentFoods, cachedRecentFoods, addFavorite, removeFavorite, isFavorite } from '../services/data.js';
import { openFoodLogger, openCamera, pickPhoto, openBarcode, commit, defaultMealType, portionText } from './food-logger.js';
import { mealsView, bindMealActions, loadYesterday } from './meals.js';
import { openCalendar } from './lazy.js';

const QUICK_COUNT = 8;

export function mountFood(root) {
  const disposers = [];
  let yesterday = null;
  let meal = defaultMealType();
  let quick = [];

  setHTML(root, html`
    <div class="page-head">
      <div><h1>Food</h1><p class="small muted" id="f-sub"></p></div>
      <div class="date-nav" role="group" aria-label="Choose day">
        <button class="icon-btn" type="button" data-action="prev" aria-label="Previous day">${icon('chevronLeft')}</button>
        <button class="date-label" type="button" data-action="calendar" id="f-date" aria-label="Open calendar"></button>
        <button class="icon-btn" type="button" data-action="next" aria-label="Next day" id="f-next">${icon('chevronRight')}</button>
      </div>
    </div>
    <div class="dash-grid">
      <div class="cards">
        <section class="card" aria-label="Log food">
          <div class="card-head"><h2 class="card-title">Log food</h2><span class="small muted">AI first — you review before saving</span></div>
          <div class="method-grid">
            <button type="button" class="method primary" data-action="ai">${icon('sparkles')}<span><b>Describe with AI</b><small>Type what you ate</small></span></button>
            <button type="button" class="method" data-action="camera">${icon('camera')}<span><b>AI photo</b><small>Snap your plate</small></span></button>
            <button type="button" class="method" data-action="photo">${icon('image')}<span><b>From gallery</b><small>Pick a photo</small></span></button>
            <button type="button" class="method" data-action="barcode">${icon('barcode')}<span><b>Barcode</b><small>Packaged food</small></span></button>
            <button type="button" class="method" data-action="search">${icon('search')}<span><b>My foods</b><small>Search favorites & recent</small></span></button>
            <button type="button" class="method" data-action="manual">${icon('edit')}<span><b>Manual</b><small>Enter the values</small></span></button>
          </div>
        </section>
        <section class="card" id="f-meals" aria-label="Meals"></section>
      </div>
      <div class="cards">
        <section class="card" id="f-summary" aria-label="Day summary"></section>
        <section class="card" id="f-quick" aria-label="Quick add from my foods"></section>
      </div>
    </div>`);

  const renderHeader = () => {
    const d = state.date;
    $('#f-date', root).textContent = d === today() ? `Today · ${formatDay(d, { month: 'short', day: 'numeric' })}` : relativeDayLabel(d);
    $('#f-next', root).disabled = d >= today();
  };

  const renderDay = () => {
    const day = state.day;
    if (!day) {
      setHTML($('#f-meals', root), html`<div class="skeleton" style="height:160px"></div><p class="tiny faint" style="margin-top:8px">Loading your meals…</p>`);
      setHTML($('#f-summary', root), html`<div class="skeleton" style="height:110px"></div>`);
      return;
    }
    const g = currentGoals();
    const t = sumNutrition(day.items);
    $('#f-sub', root).textContent = `${fmtInt(t.calories)} of ${fmtInt(g.calories)} kcal · ${day.items.length} food${day.items.length === 1 ? '' : 's'}`;
    const row = (label, color, v, goal, unit = 'g') => html`<div class="sum-row">
      <span class="row"><i class="dot" style="background:var(${color})"></i>${label}</span>
      <span class="small"><b>${unit === 'kcal' ? fmtInt(v) : fmt1(v)}</b> / ${fmtInt(goal)} ${unit} · ${fmtInt(goal > 0 ? (v / goal) * 100 : 0)}%</span>
      <div class="bar"><span style="width:${Math.min(100, goal > 0 ? (v / goal) * 100 : 0)}%;background:var(${color})"></span></div></div>`;
    setHTML($('#f-summary', root), html`
      <div class="card-head"><h2 class="card-title">${state.date === today() ? 'Today' : formatDay(state.date)}</h2><a class="small" href="#/dashboard">Dashboard →</a></div>
      ${row('Calories', '--c-calories', t.calories, g.calories, 'kcal')}
      ${row('Protein', '--c-protein', t.protein, g.protein)}
      ${row('Carbs', '--c-carbs', t.carbs, g.carbs)}
      ${row('Fat', '--c-fat', t.fat, g.fat)}
      ${row('Fiber', '--c-fiber', t.fiber, g.fiber)}`);
    setHTML($('#f-meals', root), html`
      <div class="card-head"><h2 class="card-title">Meals</h2><span class="small muted">${day.items.length} item${day.items.length === 1 ? '' : 's'}</span></div>
      ${mealsView(day, state.date, { yesterday })}`);
  };

  const renderQuick = () => {
    quick = withFavorites(cachedRecentFoods(), state.favorites).slice(0, QUICK_COUNT);
    setHTML($('#f-quick', root), html`
      <div class="card-head"><h2 class="card-title">${icon('star', 18)} Quick add</h2><button type="button" class="link-btn" data-action="search">Search all</button></div>
      <div class="chips" role="group" aria-label="Meal">${MEAL_TYPES.map((m) => html`<button type="button" class="chip" data-quick-meal="${m.id}" aria-pressed="${m.id === meal}">${m.icon} ${m.label}</button>`)}</div>
      ${quick.length ? html`<div class="food-list">${quick.map((f, i) => html`
        <div class="food-row">
          <div class="item-main"><div class="item-name">${f.food_name}</div><div class="item-meta"><span>${portionText(f)}</span><span>${fmtInt(f.calories)} kcal</span></div></div>
          <button type="button" class="icon-btn star ${f.favorite ? 'on' : ''}" data-action="quick-star" data-i="${i}" aria-pressed="${!!f.favorite}" aria-label="${f.favorite ? 'Remove from favorites' : 'Save to favorites'}: ${f.food_name}">${icon(f.favorite ? 'starFill' : 'star', 18)}</button>
          <button type="button" class="icon-btn add" data-action="quick-add" data-i="${i}" aria-label="Add ${f.food_name} (${portionText(f)})">${icon('plus', 18)}</button>
        </div>`)}</div>`
        : html`<div class="empty compact"><div class="empty-title">Your foods will appear here</div><div class="empty-sub">Everything you log is remembered so you can add it again in one tap. Star a food to keep it at the top.</div></div>`}`);
  };

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
      console.error('[NutriLog] food day', e);
      if (!state.day) setHTML($('#f-meals', root), html`<div class="error-state"><div class="empty-title">Couldn't load your meals</div><p class="small muted">${navigator.onLine ? 'Something went wrong. Please try again.' : "You're offline."}</p><button type="button" class="btn btn-secondary btn-sm" data-action="retry">Retry</button></div>`);
    }
  };

  const setDate = (d) => { if (d <= today()) { state.date = d; loadDay(); } };

  disposers.push(bindActions(root, {
    prev: () => setDate(addDays(state.date, -1)),
    next: () => setDate(addDays(state.date, 1)),
    calendar: () => openCalendar({ selected: state.date, onPick: setDate }),
    ai: () => openFoodLogger({ mealType: meal }),
    camera: () => openCamera(),
    photo: () => pickPhoto(),
    barcode: () => openBarcode(),
    search: () => openFoodLogger({ tab: 'mine', mealType: meal }),
    manual: () => openFoodLogger({ tab: 'manual', mealType: meal }),
    retry: () => loadDay(),
    'quick-add': (el) => {
      const f = quick[Number(el.dataset.i)];
      if (!f) return;
      commit([{ ...scaleFood(f, f.quantity), source: 'manual' }], meal);
    },
    'quick-star': (el) => {
      const f = quick[Number(el.dataset.i)];
      if (!f) return;
      if (f.favorite || isFavorite(f)) { removeFavorite(f); toast(`Removed ${f.food_name} from favorites.`); }
      else { addFavorite(f); toast(`${f.food_name} saved to favorites ✓`, 'success'); }
    },
  }));
  root.addEventListener('click', (e) => {
    const m = e.target.closest('[data-quick-meal]');
    if (!m) return;
    meal = m.dataset.quickMeal;
    root.querySelectorAll('[data-quick-meal]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.quickMeal === meal)));
  });
  disposers.push(bindMealActions(root, { getDay: () => state.day, getDate: () => state.date, getYesterday: () => yesterday }));
  disposers.push(on('day', () => { renderDay(); renderQuick(); }));
  disposers.push(on('favorites', () => { renderDay(); renderQuick(); }));
  disposers.push(on('account', renderDay));
  disposers.push(on('remote-day', (d) => { if (d === state.date) loadDay(); }));

  renderQuick();
  loadDay();
  fetchRecentFoods().then(renderQuick).catch((e) => console.warn('[NutriLog] recent foods', e.message));
  return () => disposers.forEach((d) => d());
}
