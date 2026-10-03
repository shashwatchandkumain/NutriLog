// Weekly AI report (Pro): "Based on my last 7 days, what should I change?" — the exact numbers
// from the user's logs plus the coach's advice. Reports are saved (ai_reports) so opening one
// again costs nothing.
import { html, setHTML, fmtInt, fmt1, formatDay, today } from '../lib/utils.js';
import { hasFeature, emit } from '../store.js';
import { showError, withBusy, openSheet } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { sb } from '../services/supabase.js';
import { weeklyReport } from '../services/ai.js';

const day = (iso) => formatDay(iso, { day: 'numeric', month: 'short' });

export function reportView(r) {
  const s = r.stats || {};
  const tile = (label, value, sub = '') => html`<div class="tile"><div class="tile-label">${label}</div><div class="tile-value">${value}</div>${sub ? html`<div class="tile-delta">${sub}</div>` : ''}</div>`;
  return html`<div class="stack report">
    <div class="eyebrow">${day(s.start)} – ${day(s.end)} · ${s.days_logged} day${s.days_logged === 1 ? '' : 's'} logged</div>
    <h3 class="report-headline">${r.headline}</h3>
    <div class="tiles">
      ${tile('Avg calories', s.avg_calories == null ? '—' : html`${fmtInt(s.avg_calories)}<small> kcal</small>`, s.target_calories ? `target ${fmtInt(s.target_calories)} · on target ${s.calorie_days_on_target}/${s.days_logged} days` : '')}
      ${tile('Avg protein', s.avg_protein == null ? '—' : html`${fmt1(s.avg_protein)}<small> g</small>`, s.target_protein ? `target ${fmtInt(s.target_protein)} g · hit ${s.protein_days_hit}/${s.days_logged} days` : '')}
      ${tile('Weight', s.weight_change == null ? '—' : html`${s.weight_change > 0 ? '+' : s.weight_change < 0 ? '−' : '±'}${fmt1(Math.abs(s.weight_change))}<small> kg</small>`, s.weight_end ? `now ${fmt1(s.weight_end)} kg` : 'no weigh-ins')}
      ${tile('Activity', html`${fmtInt(s.activity_minutes)}<small> min</small>`, `${s.active_days} active day${s.active_days === 1 ? '' : 's'} · ${fmtInt(s.activity_kcal)} kcal`)}
      ${tile('Water', s.avg_water_ml == null ? '—' : html`${fmt1(s.avg_water_ml / 1000)}<small> L/day</small>`, `goal ${fmt1(s.water_goal_ml / 1000)} L`)}
    </div>
    ${r.wins?.length ? html`<div><h4>✅ What went well</h4><ul class="report-list">${r.wins.map((w) => html`<li>${w}</li>`)}</ul></div>` : ''}
    ${r.changes?.length ? html`<div><h4>🎯 Change next week</h4><ol class="report-list">${r.changes.map((c) => html`<li><b>${c.title}</b> — ${c.detail}</li>`)}</ol></div>` : ''}
    ${r.focus ? html`<div class="form-note">${icon('target', 16)} <span><b>Focus:</b> ${r.focus}</span></div>` : ''}
    <p class="tiny faint">Numbers are calculated from your log. Advice is AI-generated — general guidance, not medical advice.</p>
  </div>`;
}

/** Progress-page card: latest report, or the button to create one. */
export function weeklyCard(container) {
  const render = async () => {
    if (!hasFeature('weekly_report')) {
      setHTML(container, html`<div class="card-head"><h2 class="card-title">${icon('sparkles', 18)} Weekly AI report</h2><span class="tag">Pro</span></div>
        <p class="small muted">Every week: what went well, what to change and one focus — based on your food, protein, weight, activity and water.</p>
        <button type="button" class="btn btn-primary btn-sm" data-upgrade style="margin-top:10px">Unlock with Pro</button>`);
      container.querySelector('[data-upgrade]').addEventListener('click', () => emit('upgrade', { reason: 'plan_required', message: 'The weekly AI report is part of Pro and Pro AI.' }));
      return;
    }
    const { data } = await sb.from('ai_reports').select('id, content, created_at').eq('kind', 'weekly_report').order('created_at', { ascending: false }).limit(1);
    const last = data?.[0];
    setHTML(container, html`<div class="card-head"><h2 class="card-title">${icon('sparkles', 18)} Weekly AI report</h2>${last ? html`<span class="small muted">${day(last.created_at.slice(0, 10))}</span>` : ''}</div>
      ${last ? html`<p><b>${last.content.headline}</b></p>${last.content.focus ? html`<p class="small muted">Focus: ${last.content.focus}</p>` : ''}` : html`<p class="small muted">Your last 7 days, explained — and what to change next week.</p>`}
      <div class="row wrap" style="margin-top:10px">
        ${last ? html`<button type="button" class="btn btn-secondary btn-sm" data-open>Read report</button>` : ''}
        <button type="button" class="btn ${last ? 'btn-ghost' : 'btn-primary'} btn-sm" data-new>${icon('sparkles', 14)} ${last ? 'New report' : 'Get my report'} · 10 credits</button>
      </div>`);
    container.querySelector('[data-open]')?.addEventListener('click', () => show(last.content));
    container.querySelector('[data-new]').addEventListener('click', (e) => withBusy(e.currentTarget, 'Writing your report…', async () => {
      try { const r = await weeklyReport(today()); show(r.report); render(); } catch (err) { if (!['no_credits', 'plan_required'].includes(err?.code)) showError(err, 'weekly report'); }
    }));
  };
  const show = (report) => {
    const sheet = openSheet({ title: 'Weekly AI report', wide: true });
    setHTML(sheet.body, reportView(report));
  };
  render().catch((e) => console.warn('[NutriLog] weekly card', e.message));
  return render;
}

