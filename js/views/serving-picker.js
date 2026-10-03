// Amount picker for a food: its saved servings ("1 large egg"), a − / + stepper with fractions,
// quick amounts, or grams — with a live nutrition preview. Servings come from the food's
// database record; nothing is hard-coded per food.
import { html, setHTML, fmtInt, fmt1 } from '../lib/utils.js';
import { nutritionFor, defaultServing } from '../lib/food-resolve.js';

const GRAMS = '__grams__';

/**
 * Renders into `container`. `initial` = { quantity, servingLabel, grams }.
 * Returns { get(): { quantity, servingLabel, grams } | null }.
 */
export function servingPicker(container, food, initial = {}, onChange) {
  const unit = food.base_unit || 'g';
  const servings = food.servings || [];
  const startServing = initial.servingLabel && initial.servingLabel !== unit && servings.find((s) => s.label === initial.servingLabel);
  let mode = startServing ? startServing.label : initial.servingLabel === unit || !servings.length ? GRAMS : (defaultServing(food)?.label || GRAMS);
  let qty = mode === GRAMS ? (initial.grams || 100) : (startServing ? initial.quantity || 1 : 1);

  const serving = () => servings.find((s) => s.label === mode);
  const grams = () => (mode === GRAMS ? qty : qty * (serving()?.grams || 0));
  const step = () => (mode === GRAMS ? 10 : 0.25);
  const quick = () => (mode === GRAMS ? [25, 50, 100, 150, 200] : [0.5, 1, 1.5, 2, 3, 4]);
  const round = (v) => Math.round(v * 100) / 100;

  setHTML(container, html`
    <div class="serving-picker stack-sm">
      <div class="field"><label>Serving</label>
        <select class="select" data-sp="serving">
          ${servings.map((s) => html`<option value="${s.label}" ${mode === s.label ? 'selected' : ''}>${s.label} (${fmt1(s.grams)} ${unit})</option>`)}
          <option value="${GRAMS}" ${mode === GRAMS ? 'selected' : ''}>${unit === 'ml' ? 'Millilitres (ml)' : 'Grams (g)'}</option>
        </select></div>
      <div class="field"><label>Amount</label>
        <div class="stepper" role="group" aria-label="Amount">
          <button type="button" class="icon-btn" data-sp="minus" aria-label="Less">−</button>
          <input class="input" type="number" inputmode="decimal" min="0" step="any" data-sp="qty" aria-label="Amount">
          <button type="button" class="icon-btn" data-sp="plus" aria-label="More">+</button>
        </div></div>
      <div class="chips" data-sp="quick" role="group" aria-label="Quick amounts"></div>
      <p class="small muted" data-sp="grams" aria-live="polite"></p>
      <div data-sp="preview" aria-live="polite"></div>
    </div>`);
  const $ = (k) => container.querySelector(`[data-sp="${k}"]`);
  const draw = (fromInput = false) => {
    if (!fromInput) $('qty').value = String(round(qty));
    setHTML($('quick'), html`${quick().map((v) => html`<button type="button" class="chip" data-q="${v}" aria-pressed="${round(qty) === v}">${mode === GRAMS ? `${v} ${unit}` : v}</button>`)}`);
    const g = grams();
    $('grams').textContent = mode === GRAMS ? '' : `= ${fmt1(g)} ${unit}`;
    const n = nutritionFor(food, g);
    setHTML($('preview'), html`<div class="sum-line"><b>${fmtInt(n.calories)} kcal</b> · ${fmt1(n.protein)} g protein · ${fmt1(n.carbs)} g carbs · ${fmt1(n.fat)} g fat · ${fmt1(n.fiber)} g fiber</div>`);
    onChange?.(api.get());
  };
  const api = { get: () => (qty > 0 && grams() > 0 ? { quantity: round(qty), servingLabel: mode === GRAMS ? unit : mode, grams: round(grams()) } : null) };

  $('serving').addEventListener('change', (e) => {
    const g = grams();
    mode = e.target.value;
    // Switching keeps the same weight where possible (200 g → 4 × 1 large egg).
    qty = mode === GRAMS ? round(g) || 100 : Math.max(0.25, round(g / (serving()?.grams || g || 1)) || 1);
    draw();
  });
  $('minus').addEventListener('click', () => { qty = Math.max(step(), round(qty - step())); draw(); });
  $('plus').addEventListener('click', () => { qty = round(qty + step()); draw(); });
  $('qty').addEventListener('input', (e) => { const v = Number(e.target.value); qty = v > 0 ? v : 0; draw(true); });
  $('quick').addEventListener('click', (e) => { const b = e.target.closest('[data-q]'); if (b) { qty = Number(b.dataset.q); draw(); } });
  draw();
  return api;
}
