// Meals for a day — Breakfast, Lunch, Dinner, Snacks — shared by the Dashboard and the Food
// page. Each meal shows its foods and totals; items can be edited, duplicated, saved as a
// favorite or deleted, and meals can be copied to today or repeated from yesterday.
import { html, setHTML, fmtInt, fmt1, today, addDays, formatDay, MEAL_TYPES } from '../lib/utils.js';
import { sumNutrition, NUTRIENTS } from '../lib/nutrition.js';
import { openSheet, toast, bindActions, $ } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { logItems, updateItem, deleteItem, addFavorite, removeFavorite, isFavorite, cachedDay, fetchDay } from '../services/data.js';
import { openFoodLogger, openCorrection } from './food-logger.js';
import { foodById } from '../services/food-db.js';

const macroLine = (n) => `P ${fmt1(n.protein)} · C ${fmt1(n.carbs)} · F ${fmt1(n.fat)}`;
const copyOf = (it) => ({ food_id: it.food_id, food_name: it.food_name, source: it.source, quantity: it.quantity, unit: it.unit, grams: it.grams,
  calories: it.calories, protein: it.protein, carbs: it.carbs, fat: it.fat, fiber: it.fiber, food_ref: it.food_ref || null, micros: it.micros || null });

/** The meal sections for `day` (on `date`). `yesterday` (optional) enables "repeat" links. */
export function mealsView(day, date, { yesterday = null } = {}) {
  const count = day.items.length;
  const isToday = date === today();
  return html`
    ${MEAL_TYPES.map((m) => {
      const items = day.items.filter((i) => i.meal_type === m.id);
      const t = sumNutrition(items);
      const prev = isToday && !items.length ? (yesterday?.items || []).filter((i) => i.meal_type === m.id) : [];
      return html`<section class="meal-group" aria-label="${m.label}">
        <div class="meal-head">
          <h3><span aria-hidden="true">${m.icon}</span>${m.label}</h3>
          ${items.length ? html`<span class="meal-total"><b>${fmtInt(t.calories)} kcal</b><span class="tiny muted">${macroLine(t)}</span></span>` : ''}
        </div>
        ${items.map((it) => html`
          <div class="item ${it.pending ? 'pending' : ''}">
            <button type="button" class="item-open" data-action="edit-item" data-id="${it.id}" aria-label="Edit ${it.food_name}">
              <span class="item-main">
                <span class="item-name">${it.food_name}</span>
                <span class="item-meta"><span>${fmt1(it.quantity)} ${it.unit}${it.grams && it.unit !== 'g' && it.unit !== 'ml' ? ` · ${fmtInt(it.grams)} g` : ''}</span>
                  <span>${macroLine(it)}</span>${it.pending ? html`<span>· saving…</span>` : ''}</span>
              </span>
              <span class="item-kcal">${fmtInt(it.calories)} <small>kcal</small></span>
            </button>
            <button type="button" class="icon-btn star ${isFavorite(it) ? 'on' : ''}" data-action="fav-item" data-id="${it.id}" aria-pressed="${isFavorite(it)}" aria-label="${isFavorite(it) ? 'Remove from favorites' : 'Save to favorites'}: ${it.food_name}">${icon(isFavorite(it) ? 'starFill' : 'star', 18)}</button>
          </div>`)}
        <div class="meal-foot">
          <button type="button" class="add-to-meal" data-action="add-to" data-meal="${m.id}">${icon('plus', 16)} Add to ${m.label.toLowerCase()}</button>
          ${!isToday && items.length ? html`<button type="button" class="link-btn" data-action="copy-meal" data-meal="${m.id}">${icon('copy', 14)} Copy to today</button>` : ''}
          ${prev.length ? html`<button type="button" class="link-btn" data-action="repeat-meal" data-meal="${m.id}">${icon('repeat', 14)} Repeat yesterday's (${fmtInt(sumNutrition(prev).calories)} kcal)</button>` : ''}
        </div>
      </section>`;
    })}
    ${count === 0 ? html`<p class="tiny faint center" style="margin-top:6px">${isToday ? 'Nothing logged yet today.' : `Nothing logged on ${formatDay(date)}.`}</p>` : ''}`;
}

/** Wires the meal actions inside `root`. Returns a disposer. */
export function bindMealActions(root, { getDay, getDate, getYesterday }) {
  return bindActions(root, {
    'edit-item': (el) => { const it = getDay()?.items.find((x) => x.id === el.dataset.id); if (it) editItem(it); },
    'fav-item': (el) => {
      const it = getDay()?.items.find((x) => x.id === el.dataset.id);
      if (!it) return;
      if (isFavorite(it)) { removeFavorite(it); toast(`Removed ${it.food_name} from favorites.`); }
      else { addFavorite(it); toast(`${it.food_name} saved to favorites ✓`, 'success'); }
    },
    'add-to': (el) => openFoodLogger({ mealType: el.dataset.meal }),
    'copy-meal': (el) => {
      const items = (getDay()?.items || []).filter((i) => i.meal_type === el.dataset.meal);
      if (!items.length) return;
      const saved = logItems(today(), el.dataset.meal, items.map(copyOf));
      const label = MEAL_TYPES.find((m) => m.id === el.dataset.meal)?.label;
      toast(`${label} copied to today ✓`, 'success', { action: 'Undo', onAction: () => saved.forEach((it) => deleteItem({ ...it, meal_date: today() })) });
    },
    'repeat-meal': (el) => {
      const items = (getYesterday?.()?.items || []).filter((i) => i.meal_type === el.dataset.meal);
      if (!items.length) return;
      const date = getDate();
      const saved = logItems(date, el.dataset.meal, items.map(copyOf));
      const label = MEAL_TYPES.find((m) => m.id === el.dataset.meal)?.label;
      toast(`Yesterday's ${label.toLowerCase()} added ✓`, 'success', { action: 'Undo', onAction: () => saved.forEach((it) => deleteItem({ ...it, meal_date: date })) });
    },
  });
}

/**
 * Yesterday's meals for the "repeat" links: calls `onLoad(day)` with this device's copy right
 * away (if any), then again with the server's (meals may have been logged on another device).
 */
export function loadYesterday(date, onLoad) {
  const y = addDays(date, -1);
  const cached = cachedDay(y);
  if (cached) onLoad(cached);
  fetchDay(y).then(onLoad).catch(() => {});
}

// ── Edit sheet ────────────────────────────────────────────────────────────
/**
 * Edit a logged food: name, amount (nutrition scales linearly from what was logged), the
 * nutrition values themselves, and the meal. Also duplicate, favorite or delete it.
 */
export function editItem(item) {
  let meal = item.meal_type;
  const base = Number(item.quantity) || 1;
  const sheet = openSheet({ title: 'Edit food', footer: true });
  const field = (k, label) => html`<div class="field"><label for="e-${k}">${label}</label><input class="input" id="e-${k}" name="${k}" type="number" inputmode="decimal" min="0" step="any" value="${Math.round(Number(item[k]) * 10) / 10}"></div>`;
  setHTML(sheet.body, html`
    <form class="stack" id="e-form" novalidate>
      <div class="field"><label for="e-name">Food</label><input class="input" id="e-name" name="food_name" maxlength="200" value="${item.food_name}"></div>
      <div class="qty-row">
        <div class="field"><label for="e-qty">Amount</label><input class="input" id="e-qty" name="quantity" type="number" inputmode="decimal" min="0.1" step="any" value="${fmt1(item.quantity)}"></div>
        <div class="field"><label for="e-unit">Unit</label><input class="input" id="e-unit" value="${item.unit}" disabled></div>
      </div>
      <p class="small muted">Nutrition for this amount — changing the amount rescales it; you can also correct any value.</p>
      <div class="grid-3">${field('calories', 'Calories')}${field('protein', 'Protein g')}${field('carbs', 'Carbs g')}${field('fat', 'Fat g')}${field('fiber', 'Fiber g')}</div>
      <div class="chips" role="group" aria-label="Meal">${MEAL_TYPES.map((m) => html`<button type="button" class="chip" data-meal="${m.id}" aria-pressed="${m.id === meal}">${m.icon} ${m.label}</button>`)}</div>
      <div class="row wrap">
        <button type="button" class="btn btn-ghost btn-sm" data-dup>${icon('copy', 16)} Duplicate</button>
        <button type="button" class="btn btn-ghost btn-sm" data-fav>${icon(isFavorite(item) ? 'starFill' : 'star', 16)} ${isFavorite(item) ? 'Saved to favorites' : 'Save to favorites'}</button>
      </div>
      ${item.food_ref ? html`<p class="tiny muted src-line">${icon('database', 12)} From the NutriLog database — this entry keeps the values it was logged with. <button type="button" class="link-btn" data-report>Report wrong values</button></p>` : ''}
    </form>`);
  setHTML(sheet.foot, html`<button type="button" class="btn btn-danger" data-del>${icon('trash', 16)} Delete</button><button type="button" class="btn btn-primary" data-save>Save</button>`);
  const form = $('#e-form', sheet.body);
  const qty = form.elements.namedItem('quantity');
  qty.addEventListener('input', () => {
    const q = Number(qty.value);
    if (!(q > 0)) return;
    for (const k of NUTRIENTS) form.elements.namedItem(k).value = String(Math.round(((Number(item[k]) || 0) * q / base) * 10) / 10);
  });
  form.addEventListener('click', (e) => {
    const m = e.target.closest('[data-meal]');
    if (m) { meal = m.dataset.meal; form.querySelectorAll('[data-meal]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.meal === meal))); }
  });
  const read = () => {
    const q = Number(qty.value);
    if (!(q > 0)) return null;
    const out = { food_name: String(form.elements.namedItem('food_name').value || '').trim() || item.food_name, quantity: q, grams: item.grams ? item.grams * (q / base) : null };
    for (const k of NUTRIENTS) {
      const v = Number(form.elements.namedItem(k).value);
      if (!Number.isFinite(v) || v < 0) return null;
      // Keep the exact stored value when the field still shows its (rounded) scaled value.
      const scaled = (Number(item[k]) || 0) * (q / base);
      out[k] = Math.abs(v - Math.round(scaled * 10) / 10) < 1e-9 ? scaled : v;
    }
    return out;
  };
  sheet.foot.querySelector('[data-save]').addEventListener('click', () => {
    const n = read();
    if (!n) { toast('Enter an amount greater than zero and valid nutrition values.', 'error'); return; }
    updateItem(item, meal, n);
    sheet.close();
    toast(`${n.food_name} updated ✓`, 'success');
  });
  sheet.foot.querySelector('[data-del]').addEventListener('click', () => {
    deleteItem(item);
    sheet.close();
    toast(`Deleted ${item.food_name}.`, 'info', { action: 'Undo', onAction: () => logItems(item.meal_date, item.meal_type, [copyOf(item)]) });
  });
  form.querySelector('[data-dup]').addEventListener('click', () => {
    const [copy] = logItems(item.meal_date, meal, [copyOf(item)]);
    sheet.close();
    toast(`${item.food_name} duplicated ✓`, 'success', { action: 'Undo', onAction: () => deleteItem({ ...copy, meal_date: item.meal_date }) });
  });
  form.querySelector('[data-report]')?.addEventListener('click', async () => {
    try {
      const food = await foodById(item.food_ref);
      if (!food) { toast('That food is no longer in the database.', 'error'); return; }
      openCorrection(food);
    } catch (e) { toast("Couldn't load the food. Check your connection.", 'error'); console.warn(e); }
  });
  form.querySelector('[data-fav]').addEventListener('click', () => {
    if (isFavorite(item)) { removeFavorite(item); toast(`Removed ${item.food_name} from favorites.`); }
    else { addFavorite(item); toast(`${item.food_name} saved to favorites ✓`, 'success'); }
    sheet.close();
  });
}

