// AI meal plan + grocery list (Pro AI): a day or a week of meals that fit the user's targets,
// diet and allergies. Any meal can be logged in one tap (through the normal review, so foods in
// the NutriLog database use its values). Plans are saved, so reopening one costs nothing.
import { html, setHTML, fmtInt, fmt1, formatDay } from '../lib/utils.js';
import { state, on, hasFeature, emit } from '../store.js';
import { bindActions, toast, showError, withBusy } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { sb } from '../services/supabase.js';
import { mealPlan } from '../services/ai.js';
import { openReview } from './food-logger.js';

const MEAL_LABEL = { breakfast: '🌅 Breakfast', lunch: '🍛 Lunch', snack: '🍎 Snack', dinner: '🌙 Dinner' };
const checksKey = (id) => `nutrilog.grocery.${state.user?.id}.${id}`;

export function mountMealPlan(root) {
  let saved = null;   // { id, content, created_at }
  let dayIdx = 0;
  const disposers = [];

  const checks = () => { try { return new Set(JSON.parse(localStorage.getItem(checksKey(saved?.id))) || []); } catch { return new Set(); } };

  const render = () => {
    if (!hasFeature('meal_plan')) {
      setHTML(root, html`<div class="page-head"><div><h1>AI meal plan</h1><p class="small muted">Meals that fit your targets, + a grocery list</p></div></div>
        <section class="card locked-feature"><div class="empty"><div class="empty-icon">🥗</div>
          <div class="empty-title">Plan a day or a whole week</div>
          <div class="empty-sub">Breakfast, lunch, snack and dinner that hit your calories and protein, respect your diet and allergies, and come with one combined grocery list. Log any meal in one tap.</div>
          <button type="button" class="btn btn-primary" data-action="upgrade">Unlock with Pro AI</button></div></section>`);
      return;
    }
    const plan = saved?.content;
    const day = plan?.days?.[dayIdx];
    const done = checks();
    const grocery = plan?.grocery || [];
    const cats = [...new Set(grocery.map((g) => g.category))];
    setHTML(root, html`
      <div class="page-head"><div><h1>AI meal plan</h1><p class="small muted">${plan ? `Made ${formatDay(saved.created_at.slice(0, 10), { day: 'numeric', month: 'short' })} · target ${fmtInt(plan.targets?.calories)} kcal, ${fmtInt(plan.targets?.protein)} g protein a day` : 'Meals that fit your targets, + a grocery list'}</p></div></div>
      <div class="row wrap" style="margin-bottom:14px">
        <button type="button" class="btn btn-primary" data-action="make" data-days="1">${icon('sparkles', 16)} Plan today · 5 credits</button>
        <button type="button" class="btn btn-secondary" data-action="make" data-days="7">${icon('calendar', 16)} Plan my week · 10 credits</button>
      </div>
      ${!plan ? html`<section class="card"><div class="empty"><div class="empty-icon">🗓️</div><div class="empty-title">No plan yet</div><div class="empty-sub">Choose “Plan today” or “Plan my week”.</div></div></section>` : html`
      <div class="dash-grid"><div class="cards">
        ${plan.days.length > 1 ? html`<div class="chips" role="tablist" aria-label="Day">${plan.days.map((d, i) => html`<button type="button" class="chip" data-action="day" data-i="${i}" aria-pressed="${i === dayIdx}">Day ${d.day}</button>`)}</div>` : ''}
        <section class="card" aria-label="Day ${day.day}">
          <div class="card-head"><h2 class="card-title">Day ${day.day}</h2><span class="small"><b>${fmtInt(day.calories)} kcal</b> · ${fmt1(day.protein)} g protein</span></div>
          ${day.meals.map((m, mi) => html`<div class="meal-group">
            <div class="meal-head"><h3>${MEAL_LABEL[m.meal_type] || m.meal_type}</h3><span class="meal-total"><b>${fmtInt(m.calories)} kcal</b><span class="tiny muted">P ${fmt1(m.protein)}</span></span></div>
            ${m.items.map((it) => html`<div class="row between small plan-item"><span>${it.food_name} <span class="muted">· ${it.portion}</span></span><span>${fmtInt(it.calories)} kcal</span></div>`)}
            <button type="button" class="link-btn small" data-action="log" data-m="${mi}">${icon('plus', 14)} Log this meal</button>
          </div>`)}
        </section>
        ${plan.notes ? html`<p class="small muted">${plan.notes}</p>` : ''}
      </div><div class="cards">
        <section class="card" aria-label="Grocery list">
          <div class="card-head"><h2 class="card-title">🛒 Grocery list</h2><button type="button" class="link-btn small" data-action="copy">Copy list</button></div>
          ${cats.map((c) => html`<div class="grocery-cat"><div class="eyebrow">${c}</div>
            ${grocery.map((g, gi) => (g.category === c ? html`<label class="check-row"><input type="checkbox" data-check="${gi}" ${done.has(gi) ? 'checked' : ''}><span class="${done.has(gi) ? 'done' : ''}">${g.item} <span class="muted">· ${g.quantity}</span></span></label>` : ''))}</div>`)}
        </section>
        <p class="tiny faint">AI-generated plan — check portions and ingredients, especially for allergies. Calories are calculated from the protein, carbs and fat of each item.</p>
      </div></div>`}`);
  };

  const load = async () => {
    if (!hasFeature('meal_plan')) { render(); return; }
    const { data } = await sb.from('ai_reports').select('id, content, created_at').eq('kind', 'meal_plan').order('created_at', { ascending: false }).limit(1);
    saved = data?.[0] || null;
    dayIdx = 0;
    render();
  };

  disposers.push(bindActions(root, {
    upgrade: () => emit('upgrade', { reason: 'plan_required', message: 'AI meal plans and grocery lists are part of Pro AI.' }),
    make: (el) => withBusy(el, el.dataset.days === '7' ? 'Planning your week…' : 'Planning your day…', async () => {
      try {
        const r = await mealPlan(Number(el.dataset.days));
        saved = { id: r.id, content: r.plan, created_at: r.created_at };
        dayIdx = 0;
        render();
        toast('Your meal plan is ready ✓', 'success');
      } catch (e) { if (!['no_credits', 'plan_required'].includes(e?.code)) showError(e, 'meal plan'); }
    }),
    day: (el) => { dayIdx = Number(el.dataset.i); render(); },
    log: (el) => {
      const m = saved.content.days[dayIdx].meals[Number(el.dataset.m)];
      const items = m.items.map((it) => {
        const f = 100 / it.grams;
        return { food_name: it.food_name, portion_description: it.portion, grams: it.grams, confidence: 'medium', calories: it.calories, protein: it.protein, carbs: it.carbs, fat: it.fat, fiber: it.fiber,
          per_100g: { calories: it.calories * f, protein: it.protein * f, carbs: it.carbs * f, fat: it.fat * f, fiber: it.fiber * f } };
      });
      openReview(items, { source: 'chat', mealType: m.meal_type });
    },
    copy: async () => {
      const text = saved.content.grocery.map((g) => `• ${g.item} — ${g.quantity}`).join('\n');
      try { await navigator.clipboard.writeText(text); toast('Grocery list copied ✓', 'success'); } catch { toast("Couldn't copy — select the list instead.", 'error'); }
    },
  }));
  root.addEventListener('change', (e) => {
    const c = e.target.closest('[data-check]');
    if (!c) return;
    const set = checks();
    if (c.checked) set.add(Number(c.dataset.check)); else set.delete(Number(c.dataset.check));
    try { localStorage.setItem(checksKey(saved.id), JSON.stringify([...set])); } catch { /* ignore */ }
    c.nextElementSibling?.classList.toggle('done', c.checked);
  });
  disposers.push(on('plan', () => { if (!saved) load().catch(() => {}); }));
  load().catch((e) => { showError(e, 'meal plan'); render(); });
  return () => disposers.forEach((d) => d());
}
