// "Log food": analyze it with AI (describe, photo or camera — the default), re-log one of the
// user's own foods (search, favorites, recent), scan a barcode, or enter it manually. AI and
// barcode results always end in a review screen where every value can be checked first.
import { html, setHTML, fmtInt, fmt1, mealTypeForTime, MEAL_TYPES, today, relativeDayLabel, debounce, UserError, uuid } from '../lib/utils.js';
import { checkConsistency, scaleNutrition, sumNutrition, isValidNutrition, NUTRIENTS } from '../lib/nutrition.js';
import { searchFoods, scaleFood, withFavorites } from '../lib/food-library.js';
import { amountText, sameFood, mergeAmounts, defaultServing, nutritionFor } from '../lib/food-resolve.js';
import { nameKey } from '../lib/food-key.js';
import { state, on, aiProvider } from '../store.js';
import { openSheet, toast, showError, withBusy, $, $$ } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { unitsFor, defaultQuantity, itemFromFood, lookupBarcode, prepareImage } from '../services/foods.js';
import { PROVIDER_LABEL } from '../services/ai.js';
import { logItems, deleteItem, fetchRecentFoods, cachedRecentFoods, addFavorite, removeFavorite, isFavorite, submitFoodCandidate, reportFoodCorrection } from '../services/data.js';
import { analyzeMealText, analyzeMealPhoto, reviewItemsFromAi, itemNutrition, toLogItem, toCandidate } from '../services/meal-analysis.js';
import { searchGlobalFoods, foodByBarcode, recordResolution } from '../services/food-db.js';
import { startVoice, voiceSupported } from '../services/voice.js';
import { servingPicker } from './serving-picker.js';

export function defaultMealType() {
  return state.date === today() ? mealTypeForTime() : 'lunch';
}

export const mealChips = (selected) => html`
  <div class="chips" role="group" aria-label="Meal">
    ${MEAL_TYPES.map((m) => html`<button type="button" class="chip" data-meal="${m.id}" aria-pressed="${m.id === selected}">${m.icon} ${m.label}</button>`)}
  </div>`;

function bindMealChips(root, get, set) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-meal]');
    if (!b) return;
    set(b.dataset.meal);
    $$('[data-meal]', root).forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.meal === get())));
  });
}

const nutritionGrid = (n) => html`
  <div class="nutri-grid">
    <div class="nutri kcal"><div class="v">${fmtInt(n.calories)}</div><div class="l">kcal</div></div>
    <div class="nutri"><div class="v">${fmt1(n.protein)}g</div><div class="l"><i class="dot" style="background:var(--c-protein)"></i>Protein</div></div>
    <div class="nutri"><div class="v">${fmt1(n.carbs)}g</div><div class="l"><i class="dot" style="background:var(--c-carbs)"></i>Carbs</div></div>
    <div class="nutri"><div class="v">${fmt1(n.fat)}g</div><div class="l"><i class="dot" style="background:var(--c-fat)"></i>Fat</div></div>
    <div class="nutri"><div class="v">${fmt1(n.fiber)}g</div><div class="l"><i class="dot" style="background:var(--c-fiber)"></i>Fiber</div></div>
  </div>`;

/** Saves items and offers Undo. */
export function commit(items, mealType) {
  const date = state.date;
  const saved = logItems(date, mealType, items);
  const label = MEAL_TYPES.find((m) => m.id === mealType)?.label || 'your log';
  const what = saved.length === 1 ? saved[0].food_name : `${saved.length} items`;
  toast(`Added ${what} to ${label}${date === today() ? '' : ` (${relativeDayLabel(date)})`}`, 'success', {
    action: 'Undo',
    onAction: () => saved.forEach((it) => deleteItem({ ...it, meal_date: date })),
  });
}

// ── Main sheet ────────────────────────────────────────────────────────────
export function openFoodLogger({ tab = 'ai', mealType, query = '' } = {}) {
  let meal = mealType || defaultMealType();
  let disposeFoods = null;
  const sheet = openSheet({ title: 'Log food', wide: true, onClose: () => disposeFoods?.() });

  const renderTabs = (active) => {
    disposeFoods?.(); disposeFoods = null;
    setHTML(sheet.body, html`
      <div class="tabs" role="tablist">
        <button role="tab" type="button" data-tab="ai" aria-selected="${active === 'ai'}">${icon('sparkles', 16)} Analyze with AI</button>
        <button role="tab" type="button" data-tab="mine" aria-selected="${active === 'mine'}">${icon('star', 16)} My foods</button>
        <button role="tab" type="button" data-tab="manual" aria-selected="${active === 'manual'}">Manual</button>
      </div>
      <div class="stack" id="fl-panel"></div>`);
    sheet.body.querySelector('.tabs').addEventListener('click', (e) => {
      const t = e.target.closest('[data-tab]');
      if (t) renderTabs(t.dataset.tab);
    });
    const panel = $('#fl-panel', sheet.body);
    if (active === 'manual') manualPanel(panel);
    else if (active === 'mine') disposeFoods = myFoodsPanel(sheet, panel, { query, getMeal: () => meal, setMeal: (m) => { meal = m; }, onBack: () => renderTabs('mine') });
    else aiPanel(panel);
  };

  // AI: describe, photo, camera or barcode
  const aiPanel = (panel) => {
    setHTML(panel, html`
      <div class="field">
        <label for="fl-ai">What did you eat?</label>
        <textarea class="textarea" id="fl-ai" maxlength="1000" placeholder="e.g. 2 rotis, 1 katori dal tadka, a bowl of curd and a cup of chai with sugar">${query}</textarea>
        <span class="hint">Include amounts if you know them (2 roti, 1 katori, 200 g). You'll review every item before it's saved.</span>
      </div>
      <div class="row between wrap">
        <div class="row wrap">
          <button type="button" class="btn btn-secondary btn-sm" data-go="camera">${icon('camera', 16)} Camera</button>
          <button type="button" class="btn btn-secondary btn-sm" data-go="photo">${icon('image', 16)} Photo</button>
          <button type="button" class="btn btn-secondary btn-sm" data-go="barcode">${icon('barcode', 16)} Barcode</button>
          ${voiceSupported() ? html`<button type="button" class="btn btn-secondary btn-sm" data-voice aria-pressed="false">${icon('mic', 16)} <span>Voice</span></button>` : ''}
        </div>
        <button type="button" class="btn btn-primary" id="fl-analyze" style="margin-left:auto">${icon('sparkles', 18)} Analyze</button>
      </div>
      <p class="tiny faint">Foods NutriLog knows are calculated instantly from its database; only new foods are estimated by ${PROVIDER_LABEL[aiProvider()]} · <a href="#/settings" data-close-sheet>change AI model</a></p>`);
    const ta = $('#fl-ai', panel);
    const btn = $('#fl-analyze', panel);
    const go = () => withBusy(btn, 'Analyzing your meal…', async () => {
      const text = ta.value.trim();
      query = text;
      if (!text) { toast('Describe what you ate first.', 'error'); ta.focus(); return; }
      try {
        const res = await analyzeMealText(text);
        if (!res.items.length) { toast("Couldn't find any food in that. Try rephrasing.", 'error'); return; }
        reviewView(sheet, res.items, { meal, provider: res.provider, stats: res.stats, onMeal: (m) => { meal = m; }, onBack: () => renderTabs('ai') });
      } catch (e) { showError(e, 'AI text analysis'); }
    });
    const mic = panel.querySelector('[data-voice]');
    let listening = null;
    mic?.addEventListener('click', () => {
      if (listening) { listening.stop(); return; }
      const before = ta.value.trim();
      listening = startVoice({
        onText: (t) => { ta.value = before ? `${before} ${t}` : t; },
        onState: (on) => {
          mic.setAttribute('aria-pressed', String(on));
          mic.classList.toggle('listening', on);
          mic.querySelector('span').textContent = on ? 'Listening… tap to stop' : 'Voice';
          if (!on) listening = null;
        },
        onDone: (t) => { if (t.trim()) go(); },
        onError: (msg) => toast(msg, 'error'),
      });
    });
    btn.addEventListener('click', go);
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) go(); });
    panel.addEventListener('click', (e) => {
      const g = e.target.closest('[data-go]');
      if (g) {
        listening?.stop();
        sheet.close();
        if (g.dataset.go === 'camera') openCamera();
        else if (g.dataset.go === 'photo') pickPhoto();
        else openBarcode();
        return;
      }
      if (e.target.closest('[data-close-sheet]')) sheet.close();
    });
    requestAnimationFrame(() => ta.focus({ preventScroll: true }));
  };

  // Manual
  const manualPanel = (panel) => {
    setHTML(panel, html`
      <form class="stack" id="fl-manual" novalidate>
        <div class="field"><label for="m-name">Food name</label><input class="input" id="m-name" name="name" required maxlength="120" placeholder="e.g. Homemade poha"></div>
        <div class="grid-2">
          <div class="field"><label for="m-qty">Amount</label><input class="input" id="m-qty" name="quantity" type="number" inputmode="decimal" min="0.1" step="any" value="1"></div>
          <div class="field"><label for="m-unit">Unit</label><input class="input" id="m-unit" name="unit" maxlength="40" value="serving"></div>
        </div>
        <p class="small muted">Nutrition for the whole amount:</p>
        <div class="grid-3">
          <div class="field"><label for="m-cal">Calories</label><input class="input" id="m-cal" name="calories" type="number" inputmode="decimal" min="0" step="any" required></div>
          <div class="field"><label for="m-p">Protein g</label><input class="input" id="m-p" name="protein" type="number" inputmode="decimal" min="0" step="any" value="0"></div>
          <div class="field"><label for="m-c">Carbs g</label><input class="input" id="m-c" name="carbs" type="number" inputmode="decimal" min="0" step="any" value="0"></div>
          <div class="field"><label for="m-f">Fat g</label><input class="input" id="m-f" name="fat" type="number" inputmode="decimal" min="0" step="any" value="0"></div>
          <div class="field"><label for="m-fb">Fiber g</label><input class="input" id="m-fb" name="fiber" type="number" inputmode="decimal" min="0" step="any" value="0"></div>
        </div>
        <div id="m-check" class="small muted" aria-live="polite"></div>
        ${mealChips(meal)}
        <button class="btn btn-primary btn-block" type="submit">Add to log</button>
      </form>`);
    const form = $('#fl-manual', panel);
    bindMealChips(form, () => meal, (m) => { meal = m; });
    const read = () => {
      const f = Object.fromEntries(new FormData(form));
      return { name: String(f.name || '').trim(), quantity: Number(f.quantity), unit: String(f.unit || 'serving').trim() || 'serving',
        calories: Number(f.calories), protein: Number(f.protein) || 0, carbs: Number(f.carbs) || 0, fat: Number(f.fat) || 0, fiber: Number(f.fiber) || 0 };
    };
    form.addEventListener('input', () => {
      const v = read();
      if (!(v.calories > 0)) { $('#m-check', form).textContent = ''; return; }
      const c = checkConsistency(v);
      $('#m-check', form).textContent = c.ok ? '' : `Heads-up: these macros add up to about ${fmtInt(c.macroKcal)} kcal, not ${fmtInt(v.calories)}. Double-check the numbers.`;
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = read();
      if (!v.name) { toast('Enter a food name.', 'error'); return; }
      if (!(v.quantity > 0)) { toast('Enter an amount greater than zero.', 'error'); return; }
      if (!Number.isFinite(v.calories) || v.calories < 0 || !isValidNutrition(v)) { toast('Enter valid, non-negative nutrition values.', 'error'); return; }
      commit([{ food_name: v.name, source: 'manual', quantity: v.quantity, unit: v.unit, grams: null, calories: v.calories, protein: v.protein, carbs: v.carbs, fat: v.fat, fiber: v.fiber }], meal);
      sheet.close();
    });
  };

  renderTabs(['manual', 'mine'].includes(tab) ? tab : 'ai');
  return sheet;
}

// ── My foods: favorites + recently logged, searchable, one-tap re-log ─────
export const portionText = (f) => `${fmt1(f.quantity)} ${f.unit}${f.grams && f.unit !== 'g' && f.unit !== 'ml' ? ` · ${fmtInt(f.grams)} g` : ''}`;

function myFoodsPanel(sheet, panel, { query, getMeal, setMeal, onBack }) {
  let onlyFavorites = false;
  let foods = withFavorites(cachedRecentFoods(), state.favorites);
  setHTML(panel, html`
    <div class="search-field">${icon('search', 18)}
      <input class="input" id="mf-q" type="search" placeholder="Search your foods and the NutriLog database" autocomplete="off" enterkeyhint="search" aria-label="Search foods" value="${query}">
    </div>
    <div class="row between wrap">
      <div class="segmented" role="group" aria-label="Show">
        <button type="button" data-show="all" aria-pressed="true">Recent & favorites</button>
        <button type="button" data-show="fav" aria-pressed="false">${icon('starFill', 14)} Favorites</button>
      </div>
      ${mealChips(getMeal())}
    </div>
    <div class="food-list" id="mf-list" aria-live="polite"></div>
    <div id="mf-global" aria-live="polite"></div>`);
  const input = $('#mf-q', panel);
  const list = $('#mf-list', panel);
  const globalBox = $('#mf-global', panel);
  let globalFoods = [];
  // The shared Global Food Database, below the user's own foods.
  const drawGlobal = () => {
    const own = new Set(foods.map((f) => nameKey(f.food_name)));
    const show = onlyFavorites ? [] : globalFoods.filter((g) => !own.has(g.name_key)).slice(0, 10);
    if (!show.length) { globalBox.textContent = ''; return; }
    setHTML(globalBox, html`<div class="eyebrow" style="margin:14px 0 6px">${icon('database', 14)} From the NutriLog database</div>
      <div class="food-list">${show.map((g) => {
        const s = defaultServing(g);
        const n = nutritionFor(g, s?.grams || 100);
        return html`<div class="food-row">
          <button type="button" class="food-open" data-gopen="${g.id}">
            <span class="item-main"><span class="item-name">${g.name}</span>
              <span class="item-meta"><span>${s ? s.label : `100 ${g.base_unit}`}</span><span>P ${fmt1(n.protein)} · C ${fmt1(n.carbs)} · F ${fmt1(n.fat)}</span></span></span>
            <span class="item-kcal">${fmtInt(n.calories)} <small>kcal</small></span>
          </button>
          <button type="button" class="icon-btn star" data-gstar="${g.id}" aria-pressed="false" aria-label="Save to favorites: ${g.name}">${icon('star', 18)}</button>
          <button type="button" class="icon-btn add" data-gopen="${g.id}" aria-label="Add ${g.name}">${icon('plus', 18)}</button>
        </div>`;
      })}</div>`);
  };
  const searchGlobal = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) { globalFoods = []; drawGlobal(); return; }
    try {
      const res = await searchGlobalFoods(q);
      if (input.value.trim() === q) { globalFoods = res; drawGlobal(); }
    } catch (e) { console.warn('[NutriLog] food search', e.message); }
  }, 250);
  const draw = () => {
    const pool = onlyFavorites ? foods.filter((f) => f.favorite) : foods;
    const found = searchFoods(pool, input.value, 40);
    if (!found.length) {
      setHTML(list, html`<div class="empty"><div class="empty-icon">${icon(onlyFavorites ? 'star' : 'utensils', 24)}</div>
        <div class="empty-title">${input.value.trim() ? `No saved food matches “${input.value.trim()}”` : onlyFavorites ? 'No favorites yet' : 'Nothing logged yet'}</div>
        <div class="empty-sub">${onlyFavorites ? 'Tap the ☆ next to any food to save it here.' : 'Foods you log appear here so you can add them again in one tap.'}</div>
        <button type="button" class="btn btn-primary btn-sm" data-ai>${icon('sparkles', 16)} Analyze with AI instead</button></div>`);
      return;
    }
    setHTML(list, html`${found.map((f, i) => html`
      <div class="food-row">
        <button type="button" class="food-open" data-open="${i}">
          <span class="item-main"><span class="item-name">${f.food_name}</span>
            <span class="item-meta"><span>${portionText(f)}</span><span>P ${fmt1(f.protein)} · C ${fmt1(f.carbs)} · F ${fmt1(f.fat)}</span></span></span>
          <span class="item-kcal">${fmtInt(f.calories)} <small>kcal</small></span>
        </button>
        <button type="button" class="icon-btn star ${f.favorite ? 'on' : ''}" data-star="${i}" aria-pressed="${!!f.favorite}" aria-label="${f.favorite ? 'Remove from favorites' : 'Save to favorites'}: ${f.food_name}">${icon(f.favorite ? 'starFill' : 'star', 18)}</button>
        <button type="button" class="icon-btn add" data-add="${i}" aria-label="Add ${f.food_name} (${portionText(f)})">${icon('plus', 18)}</button>
      </div>`)}`);
    list.found = found;
  };
  const rebuild = () => { foods = withFavorites(cachedRecentFoods(), state.favorites); draw(); };
  input.addEventListener('input', debounce(draw, 120));
  input.addEventListener('input', searchGlobal);
  panel.addEventListener('click', (e) => {
    const show = e.target.closest('[data-show]');
    if (show) {
      onlyFavorites = show.dataset.show === 'fav';
      panel.querySelectorAll('[data-show]').forEach((b) => b.setAttribute('aria-pressed', String(b === show)));
      draw();
      return;
    }
    const m = e.target.closest('[data-meal]');
    if (m) { setMeal(m.dataset.meal); panel.querySelectorAll('[data-meal]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.meal === getMeal()))); return; }
    const gopen = e.target.closest('[data-gopen]');
    if (gopen) { const g = globalFoods.find((x) => x.id === gopen.dataset.gopen); if (g) globalPortionView(sheet, g, { meal: getMeal(), onMeal: setMeal, onBack }); return; }
    const gstar = e.target.closest('[data-gstar]');
    if (gstar) {
      const g = globalFoods.find((x) => x.id === gstar.dataset.gstar);
      if (!g) return;
      const s = defaultServing(g);
      const grams = s?.grams || 100;
      addFavorite({ ...nutritionFor(g, grams), food_name: g.name, quantity: s ? 1 : grams, unit: s ? s.label.replace(/^1\s+/, '') : g.base_unit, grams, food_ref: g.id });
      toast(`${g.name} saved to favorites ✓`, 'success');
      return;
    }
    if (e.target.closest('[data-ai]')) { sheet.body.querySelector('[data-tab="ai"]')?.click(); return; }
    const at = (attr) => list.found?.[Number(e.target.closest(`[${attr}]`)?.getAttribute(attr))];
    if (e.target.closest('[data-add]')) {
      const f = at('data-add');
      if (!f) return;
      commit([{ ...scaleFood(f, f.quantity), source: 'manual' }], getMeal());
      const b = e.target.closest('[data-add]');
      b.classList.add('done');
      setHTML(b, icon('check', 18));
      return;
    }
    if (e.target.closest('[data-star]')) {
      const f = at('data-star');
      if (!f) return;
      if (f.favorite || isFavorite(f)) { removeFavorite(f); toast(`Removed ${f.food_name} from favorites.`); }
      else { addFavorite(f); toast(`${f.food_name} saved to favorites ✓`, 'success'); }
      return;
    }
    if (e.target.closest('[data-open]')) {
      const f = at('data-open');
      if (f) portionView(sheet, f, { meal: getMeal(), onMeal: setMeal, onBack });
    }
  });
  draw();
  if (input.value.trim()) searchGlobal();
  requestAnimationFrame(() => input.focus({ preventScroll: true }));
  // Show cached foods instantly, then refresh from the server.
  fetchRecentFoods().then(rebuild).catch((e) => console.warn('[NutriLog] recent foods', e.message));
  return on('favorites', rebuild);
}

/** A food from the shared database: pick a serving and amount, then add it. */
function globalPortionView(sheet, food, { meal, onMeal, onBack, source = 'global', onAdded }) {
  const root = document.createElement('div');
  sheet.body.replaceChildren(root);
  sheet.setTitle(food.name);
  setHTML(root, html`
    <div class="stack">
      ${onBack ? html`<button type="button" class="link-btn" data-back style="align-self:flex-start">${icon('chevronLeft', 16)} Back</button>` : ''}
      <p class="tiny muted src-line">${icon('database', 12)} NutriLog database · per 100 ${food.base_unit}: ${fmtInt(food.calories)} kcal${food.source ? html` · <span title="${food.source}">${food.source_type === 'verified_source' ? 'USDA FoodData Central' : food.source_type === 'external_database' ? 'product label' : 'verified'}</span>` : ''}</p>
      <div data-picker></div>
      ${mealChips(meal)}
      <button type="button" class="btn btn-primary btn-block btn-lg" data-add>Add to log</button>
      <button type="button" class="link-btn" data-report style="align-self:center">Values look wrong?</button>
    </div>`);
  const picker = servingPicker(root.querySelector('[data-picker]'), food, {});
  bindMealChips(root, () => meal, (m) => { meal = m; onMeal?.(m); });
  root.querySelector('[data-back]')?.addEventListener('click', () => { sheet.setTitle('Log food'); onBack(); });
  root.querySelector('[data-report]').addEventListener('click', () => openCorrection(food));
  root.querySelector('[data-add]').addEventListener('click', () => {
    const v = picker.get();
    if (!v) { toast('Enter an amount greater than zero.', 'error'); return; }
    commit([toLogItem({ food, name: food.name, source, ...v })], meal);
    onAdded?.();
    sheet.close();
  });
}

/** Re-log one of the user's foods with a different amount (nutrition scales linearly). */
function portionView(sheet, food, { meal, onMeal, onBack }) {
  const root = document.createElement('div');
  sheet.body.replaceChildren(root);
  sheet.setTitle(food.food_name);
  setHTML(root, html`
    <div class="stack">
      <button type="button" class="link-btn" data-back style="align-self:flex-start">${icon('chevronLeft', 16)} Back</button>
      <p class="small muted">Last logged: ${portionText(food)} · ${fmtInt(food.calories)} kcal</p>
      <div class="qty-row">
        <div class="field"><label for="pv-qty">Amount</label><input class="input" id="pv-qty" type="number" inputmode="decimal" min="0.1" step="any" value="${fmt1(food.quantity)}"></div>
        <div class="field"><label for="pv-unit">Unit</label><input class="input" id="pv-unit" value="${food.unit}" disabled></div>
      </div>
      <div id="pv-preview" aria-live="polite"></div>
      ${mealChips(meal)}
      <button type="button" class="btn btn-primary btn-block btn-lg" id="pv-add">Add to log</button>
    </div>`);
  const qty = $('#pv-qty', root);
  const update = () => setHTML($('#pv-preview', root), nutritionGrid(scaleFood(food, Number(qty.value))));
  qty.addEventListener('input', update);
  bindMealChips(root, () => meal, (m) => { meal = m; onMeal?.(m); });
  root.querySelector('[data-back]').addEventListener('click', () => { sheet.setTitle('Log food'); onBack(); });
  $('#pv-add', root).addEventListener('click', () => {
    const q = Number(qty.value);
    if (!(q > 0)) { toast('Enter an amount greater than zero.', 'error'); qty.focus(); return; }
    commit([{ ...scaleFood(food, q), source: 'manual' }], meal);
    sheet.close();
  });
  update();
  qty.focus();
  qty.select?.();
}

// ── Quantity view (barcode product) ───────────────────────────────────────
function quantityView(sheet, food, { meal, onMeal, onBack }) {
  const units = unitsFor(food);
  let { unit, quantity } = defaultQuantity(food);
  const consistent = checkConsistency(food).ok;
  const root = document.createElement('div');
  sheet.body.replaceChildren(root);
  setHTML(root, html`
    <div class="stack">
      ${onBack ? html`<button type="button" class="link-btn" data-back style="align-self:flex-start">${icon('chevronLeft', 16)} Back</button>` : ''}
      <div>
        <h3>${food.name}</h3>
        <p class="small muted">${food.category || ''}${food.category ? ' · ' : ''}${fmtInt(food.calories)} kcal per 100 ${food.servingUnit}</p>
        ${food.missing ? html`<p class="tag warn" style="margin-top:6px">This product has no nutrition data. Describe it to AI or enter it manually instead.</p>` : ''}
        ${!consistent && !food.missing ? html`<p class="tag warn" style="margin-top:6px">Calories and macros on this label don't quite agree — values shown as listed.</p>` : ''}
      </div>
      <div class="qty-row">
        <div class="field"><label for="q-amount">Amount</label>
          <input class="input" id="q-amount" type="number" inputmode="decimal" min="0.1" step="any" value="${quantity}"></div>
        <div class="field"><label for="q-unit">Unit</label>
          <select class="select" id="q-unit">${units.map((u) => html`<option value="${u.id}" ${u.id === unit.id ? 'selected' : ''}>${u.label}</option>`)}</select></div>
      </div>
      <div id="q-preview" aria-live="polite"></div>
      ${mealChips(meal)}
      <button type="button" class="btn btn-primary btn-block btn-lg" id="q-add" ${food.missing ? 'disabled' : ''}>Add to log</button>
    </div>`);
  const amount = $('#q-amount', root);
  const sel = $('#q-unit', root);
  const preview = $('#q-preview', root);
  const update = () => {
    quantity = Number(amount.value);
    unit = units.find((u) => u.id === sel.value) || units[0];
    const grams = quantity > 0 ? quantity * unit.grams : 0;
    setHTML(preview, html`${nutritionGrid(scaleNutrition(food, grams))}<p class="tiny faint" style="margin-top:6px">${fmt1(grams)} ${food.servingUnit} total</p>`);
  };
  amount.addEventListener('input', update);
  sel.addEventListener('change', () => {
    const u = units.find((x) => x.id === sel.value);
    // Switching between grams and a portion keeps the same weight.
    const grams = Number(amount.value) * unit.grams;
    if (u && grams > 0) amount.value = String(Math.round((grams / u.grams) * 100) / 100);
    update();
  });
  bindMealChips(root, () => meal, (m) => { meal = m; onMeal?.(m); });
  root.querySelector('[data-back]')?.addEventListener('click', onBack);
  $('#q-add', root).addEventListener('click', () => {
    if (!(quantity > 0)) { toast('Enter an amount greater than zero.', 'error'); amount.focus(); return; }
    commit([itemFromFood(food, quantity, unit, 'barcode')], meal);
    // Share the product's label values so the next scan of this barcode is instant for everyone.
    if (String(food.id).startsWith('off:') && !food.missing && food.consistent !== false) {
      submitFoodCandidate({ name: food.name, protein: food.protein, carbs: food.carbs, fat: food.fat, fiber: food.fiber, base_unit: food.servingUnit === 'ml' ? 'ml' : 'g',
        servings: food.portions.map((p) => ({ label: p.label.split(' — ')[0], grams: p.grams })), category: 'packaged',
        source_type: 'external_database', source: 'Open Food Facts (product label)', source_id: food.id, confidence: 0.9 });
    }
    sheet.close();
  });
  update();
  amount.focus();
  amount.select?.();
}

// ── Review & add ──────────────────────────────────────────────────────────
/**
 * Nothing is saved without this screen. Each food shows where its numbers come from (the shared
 * NutriLog database, the user's own new food, or an AI estimate), its amount and nutrition.
 * Amounts can be changed, more of a food added (merging with the same food), items removed, AI
 * values corrected and wrong database values reported. Vague amounts ("a little butter") must
 * be chosen before saving — nothing is guessed.
 */
function reviewView(sheet, startItems, { meal, onMeal, onBack, photoUrl, provider, stats }) {
  let items = startItems.map((it) => ({ ...it, food: { ...it.food } }));
  let editing = null; // uid whose AI nutrition fields are open
  const root = document.createElement('div');
  sheet.body.replaceChildren(root);
  sheet.setTitle('Review & add');
  const unitOf = (it) => it.food.base_unit || 'g';
  const byUid = (uid) => items.find((x) => x.uid === uid);
  const quickAmounts = (it) => [
    ...(it.food.servings || []).slice(0, 3).map((s) => ({ label: s.label, quantity: 1, servingLabel: s.label, grams: s.grams })),
    ...[5, 10].map((g) => ({ label: `${g} ${unitOf(it)}`, quantity: g, servingLabel: unitOf(it), grams: g })),
  ];
  const sourceTag = (it) => (it.source === 'global' ? html`<span class="tag ok">${icon('check', 12)} NutriLog database</span>`
    : it.source === 'pending' ? html`<span class="tag">Your new food · not shared yet</span>`
      : html`<span class="tag warn">AI estimate</span>`);

  const render = () => {
    const ready = items.filter((it) => !it.needsAmount && it.grams > 0);
    const missing = items.filter((it) => it.needsAmount);
    const total = sumNutrition(ready.map((it) => itemNutrition(it)));
    const aiCount = items.filter((it) => it.source === 'ai').length;
    setHTML(root, html`
      <div class="stack">
        ${onBack ? html`<button type="button" class="link-btn" data-back style="align-self:flex-start">${icon('chevronLeft', 16)} Back</button>` : ''}
        ${photoUrl ? html`<img class="photo-preview" src="${photoUrl}" alt="Your food photo">` : ''}
        <div class="form-note">${icon('sparkles', 16)} <span>${aiCount
          ? html`<b>AI-generated estimate — verify portions and ingredients.</b> ${aiCount === items.length ? '' : `${items.length - aiCount} of ${items.length} foods came from the NutriLog database. `}`
          : html`<b>All from the NutriLog database</b> — no AI estimate needed. `}${provider && aiCount ? ` Estimated by ${PROVIDER_LABEL[provider] || provider}${provider !== aiProvider() ? ` (${PROVIDER_LABEL[aiProvider()]} was unavailable)` : ''}.` : ''} Check the amounts before adding.</span></div>
        ${items.map((it) => {
          const n = itemNutrition(it);
          const parent = it.modifierOf ? byUid(it.modifierOf) : null;
          return html`
          <div class="review-item" data-uid="${it.uid}">
            <div class="row">
              ${it.source === 'ai'
                ? html`<input class="input review-name" data-name="${it.uid}" maxlength="80" value="${it.name}" aria-label="Food name">`
                : html`<div class="grow review-title">${it.name}</div>`}
              <button type="button" class="btn btn-ghost btn-sm" data-remove="${it.uid}" aria-label="Remove ${it.name}">Remove</button>
            </div>
            <div class="tiny muted review-meta">${sourceTag(it)}${it.said ? html` <span>you said “${it.said}”</span>` : ''}${parent ? html` <span>· with ${parent.name}</span>` : ''}</div>
            ${it.needsAmount ? html`
              <div class="amount-ask"><div class="small"><b>How much ${it.name.toLowerCase()}?</b> Choose an amount — NutriLog doesn't guess.</div>
                <div class="chips">${quickAmounts(it).map((q, qi) => html`<button type="button" class="chip" data-quick="${it.uid}" data-qi="${qi}">${q.label}</button>`)}
                  <button type="button" class="chip" data-amount="${it.uid}">Other…</button></div></div>`
              : html`
              <div class="row between wrap">
                <button type="button" class="amount-btn" data-amount="${it.uid}" aria-label="Change amount of ${it.name}">${amountText(it, unitOf(it))} ${icon('edit', 14)}</button>
                <div class="small right"><b>${fmtInt(n.calories)} kcal</b> · P ${fmt1(n.protein)} · C ${fmt1(n.carbs)} · F ${fmt1(n.fat)} · Fib ${fmt1(n.fiber)}</div>
              </div>`}
            ${it.note ? html`<p class="tiny muted">${it.note}</p>` : ''}
            <div class="row wrap review-actions">
              <button type="button" class="btn btn-secondary btn-sm" data-more="${it.uid}" aria-label="Add more ${it.name}">${icon('plus', 14)} Add</button>
              ${it.source === 'ai' && !it.needsAmount ? html`<button type="button" class="link-btn" data-edit="${it.uid}" aria-expanded="${editing === it.uid}">${icon(editing === it.uid ? 'chevronDown' : 'edit', 14)} ${editing === it.uid ? 'Done editing nutrition' : 'Edit nutrition'}</button>` : ''}
              ${it.source === 'global' ? html`<button type="button" class="link-btn" data-report="${it.uid}">Wrong values?</button>` : ''}
            </div>
            ${editing === it.uid && !it.needsAmount ? html`<div class="grid-3">${NUTRIENTS.map((k) => html`<div class="field"><label for="rv-${k}-${it.uid}">${{ calories: 'Calories', protein: 'Protein g', carbs: 'Carbs g', fat: 'Fat g', fiber: 'Fiber g' }[k]}</label>
              <input class="input" id="rv-${k}-${it.uid}" type="number" inputmode="decimal" min="0" step="any" data-nutrient="${k}" data-uid="${it.uid}" value="${Math.round(n[k] * 10) / 10}"></div>`)}</div>` : ''}
            ${it.source === 'ai' ? html`<label class="check-row tiny muted"><input type="checkbox" data-share="${it.uid}" ${it.share ? 'checked' : ''}> Share this food's nutrition with other NutriLog users (never your name or meals)</label>` : ''}
          </div>`;
        })}
        ${items.length ? html`<div class="card" style="padding:12px;box-shadow:none">
          <div class="eyebrow" style="margin-bottom:8px">Total (${ready.length} item${ready.length === 1 ? '' : 's'})</div>
          ${nutritionGrid(total)}
        </div>` : html`<div class="empty compact"><div class="empty-title">No foods left</div></div>`}
        ${mealChips(meal)}
        ${missing.length ? html`<p class="small muted center">Choose an amount for ${missing.map((m) => m.name.toLowerCase()).join(', ')} to continue.</p>` : ''}
        <button type="button" class="btn btn-primary btn-block btn-lg" id="rv-add" ${ready.length && !missing.length ? '' : 'disabled'}>Add ${ready.length} item${ready.length === 1 ? '' : 's'}</button>
      </div>`);
    root.querySelector('[data-back]')?.addEventListener('click', () => { sheet.setTitle('Log food'); onBack(); });
  };

  /** Amount editor (change an item's amount, or add more of the same food). */
  const amountView = (it, { adding }) => {
    const view = document.createElement('div');
    sheet.body.replaceChildren(view);
    sheet.setTitle(adding ? `Add ${it.name}` : `Amount · ${it.name}`);
    setHTML(view, html`<div class="stack">
      <button type="button" class="link-btn" data-back style="align-self:flex-start">${icon('chevronLeft', 16)} Back</button>
      <div data-picker></div>
      <div class="stack-sm" data-actions></div></div>`);
    const back = () => { sheet.body.replaceChildren(root); sheet.setTitle('Review & add'); render(); };
    const initial = adding || it.needsAmount ? {} : { quantity: it.quantity, servingLabel: it.servingLabel, grams: it.grams };
    const picker = servingPicker(view.querySelector('[data-picker]'), it.food, initial);
    const same = adding ? items.find((x) => x !== it && sameFood(x, it) && !x.needsAmount) || (!it.needsAmount ? it : null) : null;
    setHTML(view.querySelector('[data-actions]'), adding && same
      ? html`<button type="button" class="btn btn-primary btn-block" data-merge>Merge with ${same.name}</button>
             <button type="button" class="btn btn-secondary btn-block" data-separate>Keep as a separate item</button>`
      : html`<button type="button" class="btn btn-primary btn-block" data-save>${adding ? 'Add' : 'Save amount'}</button>`);
    view.querySelector('[data-back]').addEventListener('click', back);
    const take = () => { const v = picker.get(); if (!v) toast('Enter an amount greater than zero.', 'error'); return v; };
    view.querySelector('[data-save]')?.addEventListener('click', () => {
      const v = take(); if (!v) return;
      if (adding) items.splice(items.indexOf(it) + 1, 0, { ...it, uid: uuid(), ...v, needsAmount: false, note: null, modifierOf: null });
      else Object.assign(it, v, { needsAmount: false, note: null });
      back();
    });
    view.querySelector('[data-merge]')?.addEventListener('click', () => {
      const v = take(); if (!v) return;
      Object.assign(same, mergeAmounts(same, v), { needsAmount: false, note: null });
      back();
    });
    view.querySelector('[data-separate]')?.addEventListener('click', () => {
      const v = take(); if (!v) return;
      items.splice(items.indexOf(it) + 1, 0, { ...it, uid: uuid(), ...v, needsAmount: false, note: null, modifierOf: null });
      back();
    });
  };

  render();
  root.addEventListener('click', (e) => {
    const t = (sel) => e.target.closest(sel);
    if (t('[data-remove]')) { const uid = t('[data-remove]').dataset.remove; items = items.filter((x) => x.uid !== uid); items.forEach((x) => { if (x.modifierOf === uid) x.modifierOf = null; }); render(); return; }
    if (t('[data-quick]')) { const it = byUid(t('[data-quick]').dataset.quick); Object.assign(it, quickAmounts(it)[Number(t('[data-quick]').dataset.qi)], { needsAmount: false }); delete it.label; render(); return; }
    if (t('[data-amount]')) { amountView(byUid(t('[data-amount]').dataset.amount), { adding: false }); return; }
    if (t('[data-more]')) { amountView(byUid(t('[data-more]').dataset.more), { adding: true }); return; }
    if (t('[data-edit]')) { const uid = t('[data-edit]').dataset.edit; editing = editing === uid ? null : uid; render(); return; }
    if (t('[data-report]')) { openCorrection(byUid(t('[data-report]').dataset.report).food); return; }
    const m = t('[data-meal]');
    if (m) { meal = m.dataset.meal; onMeal?.(meal); $$('[data-meal]', root).forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.meal === meal))); return; }
    if (t('#rv-add')) {
      const ready = items.filter((it) => !it.needsAmount && it.grams > 0);
      if (!ready.length || items.some((it) => it.needsAmount)) return;
      commit(ready.map(toLogItem), meal);
      // Confirmed AI foods become candidates for the shared database (validated on the server).
      for (const it of ready) if (it.source === 'ai' && it.share) submitFoodCandidate(toCandidate(it));
      sheet.close();
    }
  });
  root.addEventListener('change', (e) => {
    const name = e.target.closest('[data-name]');
    if (name) { const it = byUid(name.dataset.name); it.name = name.value.trim() || it.name; return; }
    const share = e.target.closest('[data-share]');
    if (share) { byUid(share.dataset.share).share = share.checked; return; }
    const nf = e.target.closest('[data-nutrient]');
    if (nf) {
      const it = byUid(nf.dataset.uid);
      const v = Number(nf.value);
      // A corrected value for this amount becomes the item's new per-100 g value.
      if (Number.isFinite(v) && v >= 0 && it.grams > 0) {
        it.food[nf.dataset.nutrient] = (v * 100) / it.grams;
        if (nf.dataset.nutrient !== 'calories') it.food.calories = 4 * it.food.protein + 4 * it.food.carbs + 9 * it.food.fat;
      }
      render();
    }
  });
}

/** "These values look wrong": sends a correction for an admin to review (never edits shared data). */
export function openCorrection(food) {
  const sheet = openSheet({ title: `Report ${food.name}`, footer: true });
  const field = (k, label) => html`<div class="field"><label for="cr-${k}">${label}</label><input class="input" id="cr-${k}" name="${k}" type="number" inputmode="decimal" min="0" max="100" step="any" value="${Math.round(Number(food[k]) * 10) / 10}"></div>`;
  setHTML(sheet.body, html`<form class="stack" novalidate>
    <p class="small muted">Values per 100 ${food.base_unit || 'g'}. Change what's wrong and tell us your source — an admin reviews every report before the shared food changes.</p>
    <div class="grid-3">${field('protein', 'Protein g')}${field('carbs', 'Carbs g')}${field('fat', 'Fat g')}${field('fiber', 'Fiber g')}</div>
    <div class="field"><label for="cr-reason">Why / source</label><textarea class="textarea" id="cr-reason" name="reason" maxlength="500" placeholder="e.g. The package label says 13 g protein per 100 g"></textarea></div>
  </form>`);
  setHTML(sheet.foot, html`<button type="button" class="btn btn-secondary" data-cancel>Cancel</button><button type="button" class="btn btn-primary" data-send>Send report</button>`);
  sheet.foot.querySelector('[data-cancel]').addEventListener('click', () => sheet.close());
  sheet.foot.querySelector('[data-send]').addEventListener('click', () => {
    const form = sheet.body.querySelector('form');
    const suggested = {};
    for (const k of ['protein', 'carbs', 'fat', 'fiber']) {
      const v = Number(form.elements.namedItem(k).value);
      if (!(v >= 0 && v <= 100)) { toast('Enter values between 0 and 100.', 'error'); return; }
      if (Math.abs(v - Number(food[k])) > 0.05) suggested[k] = v;
    }
    const reason = form.elements.namedItem('reason').value.trim();
    if (!Object.keys(suggested).length) { toast('Change at least one value.', 'error'); return; }
    if (!reason) { toast('Tell us why (e.g. your source).', 'error'); return; }
    reportFoodCorrection(food.id, suggested, reason);
    sheet.close();
    toast('Thanks — your report was sent for review.', 'success');
  });
}

/** Opens the review sheet directly (used by the AI coach's "add to log"). */
export async function openReview(aiItems, { source = 'chat', mealType, provider } = {}) {
  const sheet = openSheet({ title: 'Review & add', wide: true });
  setHTML(sheet.body, html`<div class="empty"><div class="spinner" style="margin:0 auto 12px"></div><div class="empty-title">Checking the NutriLog database…</div></div>`);
  const { items } = await reviewItemsFromAi(aiItems, source);
  if (!sheet.closed) reviewView(sheet, items, { meal: mealType || defaultMealType(), provider });
}

// ── Photo (gallery + camera) ──────────────────────────────────────────────
export function pickPhoto() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) analyzePhoto(file);
  });
  input.click();
}

async function analyzePhoto(source) {
  const sheet = openSheet({ title: 'Analyzing food…', wide: true });
  setHTML(sheet.body, html`<div class="empty"><div class="spinner" style="margin:0 auto 12px"></div><div class="empty-title">Analyzing food…</div><div class="empty-sub">This usually takes a few seconds.</div></div>`);
  try {
    const image = await prepareImage(source);
    if (sheet.closed) return;
    const res = await analyzeMealPhoto(image);
    if (sheet.closed) return;
    if (!res.items.length) {
      sheet.setTitle('No food found');
      setHTML(sheet.body, html`<div class="empty"><div class="empty-icon">📷</div><div class="empty-title">No food recognised</div>
        <div class="empty-sub">Try a clearer photo from above, or describe the food instead.</div></div>`);
      return;
    }
    reviewView(sheet, res.items, { meal: defaultMealType(), photoUrl: image.dataUrl, provider: res.provider, stats: res.stats });
  } catch (e) {
    sheet.close();
    showError(e, 'photo analysis');
  }
}

export async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) { toast('Camera is not available here. Choose a photo instead.', 'error'); pickPhoto(); return; }
  const wrap = document.createElement('div');
  wrap.className = 'camera';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-label', 'Camera');
  setHTML(wrap, html`
    <video playsinline autoplay muted></video>
    <div class="camera-bar">
      <button type="button" class="camera-btn" data-cam="close" aria-label="Close camera">${icon('x')}</button>
      <button type="button" class="shutter" data-cam="shoot" aria-label="Take photo"></button>
      <button type="button" class="camera-btn" data-cam="flip" aria-label="Switch camera">${icon('refresh')}</button>
    </div>`);
  document.body.appendChild(wrap);
  const video = wrap.querySelector('video');
  let stream = null;
  let facing = 'environment';
  const stop = () => { stream?.getTracks().forEach((t) => t.stop()); stream = null; };
  const close = () => { stop(); wrap.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  const start = async () => {
    stop();
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false });
      video.srcObject = stream;
    } catch (e) {
      close();
      console.error('[NutriLog] camera', e);
      toast(e?.name === 'NotAllowedError' ? 'Camera permission was denied. You can choose a photo from your gallery instead.' : "Couldn't open the camera. Choose a photo instead.", 'error');
    }
  };
  wrap.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cam]');
    if (!b) return;
    if (b.dataset.cam === 'close') close();
    if (b.dataset.cam === 'flip') { facing = facing === 'environment' ? 'user' : 'environment'; start(); }
    if (b.dataset.cam === 'shoot') {
      if (!video.videoWidth) { toast('Camera is still starting…'); return; }
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      close();
      analyzePhoto(canvas);
    }
  });
  start();
}

// ── Barcode ───────────────────────────────────────────────────────────────
let scannerLib = null;
function loadScanner() {
  if (window.Html5Qrcode) return Promise.resolve();
  scannerLib ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js';
    s.integrity = 'sha384-c9d8RFSL+u3exBOJ4Yp3HUJXS4znl9f+z66d1y54ig+ea249SpqR+w1wyvXz/lk+';
    s.crossOrigin = 'anonymous';
    s.onload = resolve;
    s.onerror = () => { scannerLib = null; reject(new UserError("Couldn't load the barcode scanner. Check your connection.")); };
    document.head.appendChild(s);
  });
  return scannerLib;
}

export function openBarcode() {
  let scanner = null;
  const stopScanner = async () => { try { if (scanner?.isScanning) await scanner.stop(); scanner?.clear(); } catch { /* already stopped */ } scanner = null; };
  const sheet = openSheet({ title: 'Scan a barcode', onClose: stopScanner });
  const showScanner = () => {
    setHTML(sheet.body, html`
      <div class="stack">
        <div id="barcode-reader"></div>
        <p class="small muted center" id="bc-status">Point your camera at the barcode on the pack.</p>
        <form class="row" id="bc-manual"><input class="input" name="code" inputmode="numeric" pattern="[0-9]*" placeholder="Or type the barcode number" aria-label="Barcode number"><button class="btn btn-secondary" type="submit">Look up</button></form>
      </div>`);
    $('#bc-manual', sheet.body).addEventListener('submit', (e) => { e.preventDefault(); const c = new FormData(e.target).get('code'); if (c) found(String(c)); });
    loadScanner().then(async () => {
      if (sheet.closed) return;
      scanner = new window.Html5Qrcode('barcode-reader', { verbose: false });
      await scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 260, height: 140 } }, (code) => found(code), () => {});
    }).catch((e) => {
      console.warn('[NutriLog] barcode camera unavailable', e);
      const st = $('#bc-status', sheet.body);
      if (st) st.textContent = e?.userMessage || "Camera isn't available. Type the barcode number instead.";
    });
  };
  let busy = false;
  const found = async (code) => {
    if (busy) return;
    busy = true;
    await stopScanner();
    setHTML(sheet.body, html`<div class="empty"><div class="spinner" style="margin:0 auto 12px"></div><div class="empty-title">Looking up product…</div></div>`);
    const back = () => { busy = false; sheet.setTitle('Scan a barcode'); showScanner(); };
    try {
      // The shared database first: a product someone already scanned needs no outside lookup.
      const digits = String(code).replace(/\D/g, '');
      const known = digits.length >= 6 ? await foodByBarcode(digits) : null;
      if (sheet.closed) return;
      if (known) {
        recordResolution({ global: 1 });
        globalPortionView(sheet, known, { meal: defaultMealType(), source: 'barcode', onBack: back });
        return;
      }
      const food = await lookupBarcode(code);
      if (sheet.closed) return;
      recordResolution({ external: 1 });
      sheet.setTitle('Add product');
      quantityView(sheet, food, { meal: defaultMealType(), onBack: back });
    } catch (e) {
      if (sheet.closed) return;
      setHTML(sheet.body, html`<div class="empty"><div class="empty-icon">🔎</div><div class="empty-title">${e?.userMessage || 'Lookup failed'}</div>
        <div class="row" style="justify-content:center;margin-top:10px"><button class="btn btn-secondary" type="button" data-retry>Scan again</button></div></div>`);
      sheet.body.querySelector('[data-retry]').addEventListener('click', () => { busy = false; showScanner(); });
      if (!e?.userMessage) console.error(e);
    }
  };
  showScanner();
}
