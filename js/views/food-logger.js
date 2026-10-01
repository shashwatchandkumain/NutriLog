// "Add food" flows: database search → quantity, AI description → review, photo (camera /
// gallery) → review, barcode → quantity, and manual entry. Every path ends in a screen where
// the user can check and adjust amounts before anything is saved.
import { html, setHTML, fmtInt, fmt1, mealTypeForTime, MEAL_TYPES, today, relativeDayLabel, UserError } from '../lib/utils.js';
import { checkConsistency, scaleNutrition, sumNutrition, isValidNutrition } from '../lib/nutrition.js';
import { state } from '../store.js';
import { openSheet, toast, showError, withBusy, $, $$ } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { search, loadFoods, unitsFor, defaultQuantity, itemFromFood, lookupBarcode, prepareImage } from '../services/foods.js';
import { analyzeFoodText, analyzeFoodImage } from '../services/ai.js';
import { logItems, deleteItem } from '../services/data.js';

const QUICK_PICKS = ['Roti', 'Rice', 'Dal', 'Egg', 'Banana', 'Milk', 'Chai', 'Paneer', 'Curd', 'Chicken breast'];

function defaultMealType() {
  return state.date === today() ? mealTypeForTime() : 'lunch';
}

const mealChips = (selected) => html`
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
function commit(items, mealType) {
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
export function openFoodLogger({ tab = 'search', mealType, query = '' } = {}) {
  let meal = mealType || defaultMealType();
  const sheet = openSheet({ title: 'Add food', wide: true });
  loadFoods().catch((e) => console.error(e));

  const renderTabs = (active) => {
    setHTML(sheet.body, html`
      <div class="tabs" role="tablist">
        <button role="tab" type="button" data-tab="search" aria-selected="${active === 'search'}">Search</button>
        <button role="tab" type="button" data-tab="ai" aria-selected="${active === 'ai'}">Describe with AI</button>
        <button role="tab" type="button" data-tab="manual" aria-selected="${active === 'manual'}">Manual</button>
      </div>
      <div class="stack" id="fl-panel"></div>`);
    sheet.body.querySelector('.tabs').addEventListener('click', (e) => {
      const t = e.target.closest('[data-tab]');
      if (t) renderTabs(t.dataset.tab);
    });
    const panel = $('#fl-panel', sheet.body);
    if (active === 'search') searchPanel(panel);
    else if (active === 'ai') aiPanel(panel);
    else manualPanel(panel);
  };

  // Search
  const searchPanel = (panel) => {
    setHTML(panel, html`
      <div class="search-box">${icon('search')}
        <input class="input" id="fl-q" type="search" placeholder="Search roti, dal, paneer, banana…" autocomplete="off" enterkeyhint="search" aria-label="Search foods" value="${query}">
      </div>
      <div class="results" id="fl-results" role="listbox" aria-label="Search results"></div>`);
    const input = $('#fl-q', panel);
    const results = $('#fl-results', panel);
    let seq = 0;
    const run = async () => {
      const q = input.value.trim();
      query = q;
      const my = ++seq;
      if (q.length < 2) {
        setHTML(results, html`<p class="small muted" style="margin:6px 2px 8px">Popular</p>
          <div class="chips">${QUICK_PICKS.map((p) => html`<button type="button" class="chip" data-pick="${p}">${p}</button>`)}</div>`);
        return;
      }
      let found;
      try { found = await search(q); } catch (e) {
        if (my !== seq) return;
        setHTML(results, html`<div class="empty"><div class="empty-title">${e?.userMessage || "Couldn't search right now."}</div>
          <div class="empty-sub">You can still describe the food to AI or add it manually.</div></div>`);
        return;
      }
      if (my !== seq) return;
      if (!found.length) {
        setHTML(results, html`<div class="empty"><div class="empty-title">No match for “${q}”</div>
          <div class="empty-sub">Describe it to AI instead, or add it manually.</div>
          <div class="row" style="justify-content:center">
            <button type="button" class="btn btn-primary btn-sm" data-go="ai">${icon('sparkles')} Describe with AI</button>
            <button type="button" class="btn btn-secondary btn-sm" data-go="manual">Add manually</button>
          </div></div>`);
        return;
      }
      setHTML(results, html`${found.map((f) => html`
        <button type="button" class="result" role="option" data-food="${f.id}">
          <div class="result-main">
            <div class="result-name">${f.name}</div>
            <div class="result-meta">${f.portions?.[0] ? `${f.portions[0].label} · ` : ''}per 100 ${f.servingUnit} · P ${fmt1(f.protein)} · C ${fmt1(f.carbs)} · F ${fmt1(f.fat)} · Fib ${fmt1(f.fiber)}</div>
          </div>
          <div class="result-kcal">${fmtInt(f.calories)}<small>kcal/100${f.servingUnit}</small></div>
        </button>`)}
        <button type="button" class="result" data-go="ai"><div class="result-main"><div class="result-name">${icon('sparkles', 16)} Not listed? Describe “${q}” to AI</div></div></button>`);
    };
    let t;
    input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 120); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); results.querySelector('[data-food]')?.click(); }
    });
    results.addEventListener('click', async (e) => {
      const pick = e.target.closest('[data-pick]');
      if (pick) { input.value = pick.dataset.pick; run(); input.focus(); return; }
      const go = e.target.closest('[data-go]');
      if (go) { renderTabs(go.dataset.go); return; }
      const b = e.target.closest('[data-food]');
      if (!b) return;
      const food = (await search(input.value.trim(), 30).catch(() => [])).find((f) => f.id === b.dataset.food);
      if (food) quantityView(sheet, food, { meal, onMeal: (m) => { meal = m; }, onBack: () => renderTabs('search') });
    });
    run();
  };

  // AI describe
  const aiPanel = (panel) => {
    setHTML(panel, html`
      <div class="field">
        <label for="fl-ai">What did you eat?</label>
        <textarea class="textarea" id="fl-ai" maxlength="1000" placeholder="e.g. 2 rotis, 1 katori dal tadka, a bowl of curd and a cup of chai with sugar">${query}</textarea>
        <span class="hint">Include amounts if you know them. AI estimates each item; you can adjust before saving.</span>
      </div>
      <button type="button" class="btn btn-primary btn-block" id="fl-analyze">${icon('sparkles')} Analyze</button>`);
    const ta = $('#fl-ai', panel);
    const btn = $('#fl-analyze', panel);
    const go = () => withBusy(btn, 'Analyzing food…', async () => {
      const text = ta.value.trim();
      if (!text) { toast('Describe what you ate first.', 'error'); return; }
      try {
        const items = await analyzeFoodText(text);
        if (!items.length) { toast("AI couldn't find any food in that. Try rephrasing.", 'error'); return; }
        reviewView(sheet, items, { meal, source: 'ai_text', onMeal: (m) => { meal = m; }, onBack: () => renderTabs('ai') });
      } catch (e) { showError(e, 'AI text analysis'); }
    });
    btn.addEventListener('click', go);
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) go(); });
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

  renderTabs(tab);
  return sheet;
}

// ── Quantity view (database or barcode food) ──────────────────────────────
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
        <p class="small muted">${food.category || ''}${food.category ? ' · ' : ''}${fmtInt(food.calories)} kcal per 100 ${food.servingUnit}${food.source === 'core' ? ' · reference value' : ''}</p>
        ${food.missing ? html`<p class="tag warn" style="margin-top:6px">This product has no nutrition data. Enter it manually instead.</p>` : ''}
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
    commit([itemFromFood(food, quantity, unit, food.source === 'barcode' ? 'barcode' : 'database')], meal);
    sheet.close();
  });
  update();
  amount.focus();
  amount.select?.();
}

// ── Review view (AI results) ──────────────────────────────────────────────
function reviewView(sheet, aiItems, { meal, source, onMeal, onBack, photoUrl }) {
  const rows = aiItems.map((it) => ({ ...it, keep: true }));
  const itemOf = (r) => {
    const per = r.per_100g;
    const n = scaleNutrition({ servingSize: 100, ...per }, r.grams);
    return { food_name: r.food_name, source, quantity: Math.round(r.grams * 10) / 10, unit: 'g', grams: r.grams, ...n };
  };
  const root = document.createElement('div');
  sheet.body.replaceChildren(root);
  const render = () => {
    const kept = rows.filter((r) => r.keep && r.grams > 0);
    const total = sumNutrition(kept.map(itemOf));
    setHTML(root, html`
      <div class="stack">
        ${onBack ? html`<button type="button" class="link-btn" data-back style="align-self:flex-start">${icon('chevronLeft', 16)} Back</button>` : ''}
        ${photoUrl ? html`<img class="photo-preview" src="${photoUrl}" alt="Your food photo">` : ''}
        <div class="form-note">AI estimates can be off. Check each amount — nutrition updates as you change grams.</div>
        ${rows.map((r, i) => {
          const n = itemOf(r);
          return html`
          <div class="review-item ${r.keep ? '' : 'removed'}">
            <div class="row between">
              <div class="grow"><b>${r.food_name}</b>
                <div class="tiny muted">${r.portion_description} · ${fmtInt(r.per_100g.calories)} kcal/100 g
                  ${r.confidence === 'low' ? html` · <span class="tag warn">low confidence</span>` : ''}
                  ${r.warnings?.includes('calories_adjusted_to_macros') ? html` · <span class="tag">calories matched to macros</span>` : ''}</div>
              </div>
              <button type="button" class="btn btn-ghost btn-sm" data-toggle="${i}">${r.keep ? 'Remove' : 'Keep'}</button>
            </div>
            <div class="row">
              <div class="input-group" style="width:150px"><input class="input" type="number" inputmode="decimal" min="1" step="any" data-grams="${i}" value="${Math.round(r.grams)}" aria-label="Grams of ${r.food_name}" ${r.keep ? '' : 'disabled'}><span class="input-suffix">g</span></div>
              <div class="grow small right"><b>${fmtInt(n.calories)} kcal</b> · P ${fmt1(n.protein)} · C ${fmt1(n.carbs)} · F ${fmt1(n.fat)} · Fib ${fmt1(n.fiber)}</div>
            </div>
          </div>`;
        })}
        <div class="card" style="padding:12px;box-shadow:none">
          <div class="eyebrow" style="margin-bottom:8px">Total (${kept.length} item${kept.length === 1 ? '' : 's'})</div>
          ${nutritionGrid(total)}
        </div>
        ${mealChips(meal)}
        <button type="button" class="btn btn-primary btn-block btn-lg" id="rv-add" ${kept.length ? '' : 'disabled'}>Add ${kept.length} item${kept.length === 1 ? '' : 's'}</button>
      </div>`);
    root.querySelector('[data-back]')?.addEventListener('click', () => { sheet.setTitle('Add food'); onBack(); });
  };
  sheet.setTitle('Review & add');
  render();
  root.addEventListener('click', (e) => {
    const t = e.target.closest('[data-toggle]');
    if (t) { const r = rows[Number(t.dataset.toggle)]; r.keep = !r.keep; render(); return; }
    const m = e.target.closest('[data-meal]');
    if (m) { meal = m.dataset.meal; onMeal?.(meal); $$('[data-meal]', root).forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.meal === meal))); return; }
    if (e.target.closest('#rv-add')) {
      const kept = rows.filter((r) => r.keep && r.grams > 0).map(itemOf);
      if (!kept.length) return;
      commit(kept, meal);
      sheet.close();
    }
  });
  root.addEventListener('change', (e) => {
    const g = e.target.closest('[data-grams]');
    if (!g) return;
    const v = Number(g.value);
    if (v > 0 && v <= 5000) rows[Number(g.dataset.grams)].grams = v;
    render();
  });
}

/** Opens the review sheet directly (used by the AI coach's "add to log"). */
export function openReview(items, { source = 'chat', mealType } = {}) {
  const sheet = openSheet({ title: 'Review & add', wide: true });
  reviewView(sheet, items, { meal: mealType || defaultMealType(), source });
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
    const items = await analyzeFoodImage(image);
    if (sheet.closed) return;
    if (!items.length) {
      sheet.setTitle('No food found');
      setHTML(sheet.body, html`<div class="empty"><div class="empty-icon">📷</div><div class="empty-title">No food recognised</div>
        <div class="empty-sub">Try a clearer photo from above, or search / describe the food instead.</div></div>`);
      return;
    }
    reviewView(sheet, items, { meal: defaultMealType(), source: 'ai_photo', photoUrl: image.dataUrl });
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
    try {
      const food = await lookupBarcode(code);
      if (sheet.closed) return;
      sheet.setTitle('Add product');
      quantityView(sheet, food, { meal: defaultMealType(), onBack: () => { busy = false; sheet.setTitle('Scan a barcode'); showScanner(); } });
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
