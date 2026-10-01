// Month calendar: which days have logs, and which went over the calorie target.
import { html, setHTML, isoDate, today, parseISODate } from '../lib/utils.js';
import { totalsByDate } from '../lib/stats.js';
import { currentGoals } from '../store.js';
import { openSheet } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { fetchItemsRange } from '../services/data.js';

export function openCalendar({ selected = today(), onPick } = {}) {
  const sheet = openSheet({ title: 'Calendar' });
  const sel = parseISODate(selected);
  let year = sel.getFullYear(), month = sel.getMonth();

  let seq = 0;
  const render = async () => {
    // Pin this render to its month; a slower, older load must not draw over a newer month.
    const my = ++seq;
    const y = year, mo = month;
    const first = new Date(y, mo, 1);
    const days = new Date(y, mo + 1, 0).getDate();
    const start = isoDate(first), end = isoDate(new Date(y, mo, days));
    const label = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const draw = (totals) => {
      const goal = currentGoals().calories;
      const cells = [];
      for (let i = 0; i < first.getDay(); i++) cells.push(html`<div class="cal-day blank"></div>`);
      for (let d = 1; d <= days; d++) {
        const iso = isoDate(new Date(y, mo, d));
        const t = totals?.[iso];
        const cls = ['cal-day', t ? 'logged' : '', t && t.calories > goal * 1.05 ? 'over' : '', iso === today() ? 'today' : '', iso > today() ? 'future' : ''].join(' ');
        cells.push(html`<button type="button" class="${cls}" data-day="${iso}" ${iso > today() ? 'disabled' : ''} aria-label="${iso}${t ? `, ${Math.round(t.calories)} kcal` : ''}" aria-current="${iso === selected ? 'date' : 'false'}">${d}</button>`);
      }
      setHTML(sheet.body, html`
        <div class="row between" style="margin-bottom:10px">
          <button type="button" class="icon-btn" data-m="-1" aria-label="Previous month">${icon('chevronLeft')}</button>
          <b>${label}</b>
          <button type="button" class="icon-btn" data-m="1" aria-label="Next month" ${isoDate(new Date(y, mo + 1, 1)) > today() ? 'disabled' : ''}>${icon('chevronRight')}</button>
        </div>
        <div class="cal">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => html`<div class="cal-dow" aria-hidden="true">${d}</div>`)}${cells}</div>
        <div class="legend"><span><i class="dot" style="background:var(--accent)"></i>Logged</span><span><i class="dot" style="background:var(--c-over)"></i>Over target</span></div>
        ${totals ? '' : html`<p class="small muted" style="margin-top:8px">Loading…</p>`}`);
    };
    draw(null);
    try {
      const rows = await fetchItemsRange(start, end);
      if (!sheet.closed && my === seq) draw(totalsByDate(rows));
    } catch (e) {
      console.error('[NutriLog] calendar', e);
      if (!sheet.closed && my === seq) draw({});
    }
  };

  sheet.body.addEventListener('click', (e) => {
    const m = e.target.closest('[data-m]');
    if (m) { month += Number(m.dataset.m); if (month < 0) { month = 11; year--; } if (month > 11) { month = 0; year++; } render(); return; }
    const d = e.target.closest('[data-day]');
    if (d && !d.disabled) { sheet.close(); onPick?.(d.dataset.day); }
  });
  render();
}
