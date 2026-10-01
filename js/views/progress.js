// Progress: streaks, averages, weight trend & goal progress, calorie and protein trends.
// Everything is computed from the user's logged data — no demo numbers.
import { html, setHTML, fmtInt, fmt1, today, addDays, dateRange, formatDay, parseISODate } from '../lib/utils.js';
import { formatWeight, kgToLb, macroCalories } from '../lib/nutrition.js';
import { totalsByDate, computeStreak, averageOfLoggedDays, sortWeights, weightChange, goalProgress } from '../lib/stats.js';
import { state, on, currentGoals, weightUnit } from '../store.js';
import { $, bindActions, confirmDialog, toast } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { barChart, lineChart } from '../ui/charts.js';
import { fetchItemsRange, fetchLoggedDates, fetchWeights, deleteWeight } from '../services/data.js';
import { openWeightSheet } from './dashboard.js';
import { openCalendar } from './calendar.js';
import { navigate } from '../router.js';

const RANGES = { '7': { label: '1W', days: 7 }, '30': { label: '1M', days: 30 }, '90': { label: '3M', days: 90 }, '365': { label: '1Y', days: 365 } };

export function mountProgress(root) {
  const disposers = [];
  let weightDispose = null;
  const nutritionDisposers = [];
  let range = sessionStorage.getItem('nutrilog.progressRange') || '30';
  let items = null;

  setHTML(root, html`
    <div class="page-head">
      <div><h1>Progress</h1><p class="small muted" id="p-sub">Your trends over time</p></div>
      <div class="row">
        <div class="segmented" role="group" aria-label="Time range">
          ${Object.entries(RANGES).map(([k, r]) => html`<button type="button" data-action="range" data-range="${k}" aria-pressed="${k === range}">${r.label}</button>`)}
        </div>
        <button type="button" class="icon-btn" data-action="calendar" aria-label="Open calendar">${icon('calendar')}</button>
      </div>
    </div>
    <div class="tiles" id="p-tiles"><div class="skeleton" style="height:88px"></div><div class="skeleton" style="height:88px"></div><div class="skeleton" style="height:88px"></div><div class="skeleton" style="height:88px"></div></div>
    <div class="dash-grid" style="margin-top:14px">
      <div class="cards">
        <section class="card"><div class="card-head"><h2 class="card-title">Weight</h2><button type="button" class="btn btn-secondary btn-sm" data-action="log-weight">+ Log weight</button></div>
          <div id="p-weight"></div></section>
        <section class="card"><div class="card-head"><h2 class="card-title">Calories</h2><span class="small muted" id="p-cal-note"></span></div><div id="p-cal"></div></section>
        <section class="card"><div class="card-head"><h2 class="card-title">Protein</h2><span class="small muted" id="p-prot-note"></span></div><div id="p-prot"></div></section>
      </div>
      <div class="cards">
        <section class="card" id="p-macros"></section>
        <section class="card" id="p-streak"></section>
        <section class="card" id="p-wlist"></section>
      </div>
    </div>`);

  const start = () => addDays(today(), -(RANGES[range].days - 1));

  /** Buckets days for the bar charts: daily ≤ 31 days, weekly ≤ 3 months, monthly beyond. */
  function buckets(byDay) {
    const days = dateRange(start(), today());
    const n = RANGES[range].days;
    const mk = (key, label, sub, ds, title) => {
      const avg = averageOfLoggedDays(byDay, ds);
      return { key, label, sub, title, calories: avg?.calories || 0, protein: avg?.protein || 0, logged: avg?.days || 0 };
    };
    if (n <= 31) return days.map((d) => { const dt = parseISODate(d); return mk(d, n <= 7 ? dt.toLocaleDateString(undefined, { weekday: 'short' }) : String(dt.getDate()), n <= 7 ? String(dt.getDate()) : '', [d], formatDay(d)); });
    const out = [];
    if (n <= 92) {
      for (let i = 0; i < days.length; i += 7) {
        const ds = days.slice(i, i + 7);
        out.push(mk(ds[0], formatDay(ds[0], { month: 'short', day: 'numeric' }).split(' ')[1] || '', formatDay(ds[0], { month: 'short' }), ds, `Week of ${formatDay(ds[0])} (avg)`));
      }
      return out;
    }
    const byMonth = new Map();
    for (const d of days) { const k = d.slice(0, 7); if (!byMonth.has(k)) byMonth.set(k, []); byMonth.get(k).push(d); }
    for (const [k, ds] of byMonth) out.push(mk(k, parseISODate(`${k}-15`).toLocaleDateString(undefined, { month: 'short' }), '', ds, `${parseISODate(`${k}-15`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })} (avg of logged days)`));
    return out;
  }

  const renderTiles = () => {
    const g = currentGoals();
    const unit = weightUnit();
    const streak = computeStreak(state.loggedDates);
    const byDay = items ? totalsByDate(items) : {};
    const avg = items ? averageOfLoggedDays(byDay, dateRange(start(), today())) : null;
    const w = sortWeights(state.weights);
    const ch = weightChange(w, RANGES[range].days);
    const p = state.profile || {};
    const current = w.length ? w[w.length - 1].weight_kg : p.weight_kg;
    const prog = goalProgress(p.start_weight_kg, current, p.target_weight_kg);
    const toGo = p.target_weight_kg && current ? Number(current) - Number(p.target_weight_kg) : null;
    const lossGoal = ['lose'].includes(p.goal);
    setHTML($('#p-tiles', root), html`
      <div class="tile"><div class="tile-label">🔥 Current streak</div><div class="tile-value">${streak.current}<small> day${streak.current === 1 ? '' : 's'}</small></div><div class="tile-delta">Best ${streak.best} · ${streak.daysLogged} day${streak.daysLogged === 1 ? '' : 's'} logged</div></div>
      <div class="tile"><div class="tile-label">Avg calories / day</div><div class="tile-value">${avg ? fmtInt(avg.calories) : '—'}<small> kcal</small></div><div class="tile-delta">${avg ? `${avg.days} logged day${avg.days === 1 ? '' : 's'} · target ${fmtInt(g.calories)}` : 'No meals in this range'}</div></div>
      <div class="tile"><div class="tile-label">Avg protein / day</div><div class="tile-value">${avg ? fmtInt(avg.protein) : '—'}<small> g</small></div><div class="tile-delta ${avg && avg.protein >= g.protein * 0.9 ? 'good' : ''}">target ${fmtInt(g.protein)} g</div></div>
      <div class="tile"><div class="tile-label">Weight change (${RANGES[range].label})</div><div class="tile-value">${ch ? `${ch.change > 0 ? '+' : ch.change < 0 ? '−' : ''}${formatWeight(Math.abs(ch.change), unit)}` : '—'}</div>
        <div class="tile-delta ${ch && ((lossGoal && ch.change < 0) || (!lossGoal && p.goal !== 'maintain' && ch.change > 0)) ? 'good' : ''}">${ch ? `since ${formatDay(ch.from.recorded_on, { month: 'short', day: 'numeric' })}` : 'Need 2+ weigh-ins'}</div></div>
      <div class="tile"><div class="tile-label">Goal progress</div><div class="tile-value">${prog != null ? `${Math.round(prog * 100)}%` : '—'}</div>
        <div class="tile-delta">${p.target_weight_kg ? (toGo != null && Math.abs(toGo) >= 0.05 ? `${formatWeight(Math.abs(toGo), unit)} to go` : 'Target reached 🎉') : html`<a href="#/settings">Set a target weight</a>`}</div>
        ${prog != null ? html`<div class="bar"><span style="width:${prog * 100}%"></span></div>` : ''}</div>`);
  };

  const renderWeight = () => {
    weightDispose?.();
    const unit = weightUnit();
    const w = sortWeights(state.weights);
    const s = start();
    const inRange = w.filter((x) => x.recorded_on >= s);
    const pts = (inRange.length >= 2 ? inRange : w.slice(-Math.max(2, inRange.length))).map((x) => ({
      date: x.recorded_on, value: unit === 'lb' ? kgToLb(x.weight_kg) : Number(x.weight_kg),
      label: formatDay(x.recorded_on, { month: 'short', day: 'numeric' }), title: formatDay(x.recorded_on),
    }));
    const t = state.profile?.target_weight_kg;
    weightDispose = lineChart($('#p-weight', root), pts, {
      target: t ? (unit === 'lb' ? kgToLb(Number(t)) : Number(t)) : null, unit, format: (v) => v.toFixed(1),
      emptyText: 'Log your weight on at least two days to see your trend.', ariaLabel: 'Weight over time',
    });
    const list = [...w].reverse().slice(0, 12);
    setHTML($('#p-wlist', root), html`
      <div class="card-head"><h2 class="card-title">Weigh-ins</h2><span class="small muted">${w.length} total</span></div>
      ${list.length ? list.map((x, i) => {
        const prev = list[i + 1];
        const diff = prev ? Number(x.weight_kg) - Number(prev.weight_kg) : null;
        return html`<div class="item">
          <div class="item-main"><div class="item-name">${formatWeight(x.weight_kg, unit)}</div><div class="item-meta">${formatDay(x.recorded_on)}${x.pending ? ' · saving…' : ''}</div></div>
          ${diff != null ? html`<span class="small ${diff < 0 ? 'muted' : ''}">${diff > 0 ? '+' : diff < 0 ? '−' : '±'}${formatWeight(Math.abs(diff), unit)}</span>` : ''}
          <button type="button" class="icon-btn" data-action="del-weight" data-date="${x.recorded_on}" aria-label="Delete weigh-in on ${x.recorded_on}">${icon('trash', 18)}</button>
        </div>`;
      }) : html`<div class="empty"><div class="empty-icon">⚖️</div><div class="empty-title">No weight history</div><div class="empty-sub">Log your weight regularly to see progress toward your goal.</div></div>`}`);
  };

  const renderNutrition = () => {
    const g = currentGoals();
    nutritionDisposers.splice(0).forEach((d) => d());
    if (!items) {
      for (const id of ['#p-cal', '#p-prot']) setHTML($(id, root), html`<div class="skeleton" style="height:180px"></div>`);
      return;
    }
    const byDay = totalsByDate(items);
    const b = buckets(byDay);
    const any = b.some((x) => x.logged);
    const daily = RANGES[range].days <= 31;
    $('#p-cal-note', root).textContent = daily ? 'per day' : RANGES[range].days <= 92 ? 'weekly average' : 'monthly average';
    $('#p-prot-note', root).textContent = $('#p-cal-note', root).textContent;
    if (!any) {
      setHTML($('#p-cal', root), html`<div class="chart-empty">No meals logged in this range yet.</div>`);
      setHTML($('#p-prot', root), html`<div class="chart-empty">No meals logged in this range yet.</div>`);
    } else {
      nutritionDisposers.push(barChart($('#p-cal', root), b.map((x) => ({ key: x.key, label: x.label, sub: x.sub, title: x.title, value: x.calories, className: x.calories > g.calories * 1.05 ? 'over' : '' })),
        { goal: g.calories, unit: 'kcal', ariaLabel: 'Calories over time', onSelect: daily ? (d) => { state.date = d; navigate('dashboard'); } : null }));
      nutritionDisposers.push(barChart($('#p-prot', root), b.map((x) => ({ key: x.key, label: x.label, sub: x.sub, title: x.title, value: x.protein, className: 'protein' })),
        { goal: g.protein, unit: 'g', ariaLabel: 'Protein over time', format: (v) => fmtInt(v) }));
    }
    const avg = averageOfLoggedDays(byDay, dateRange(start(), today()));
    const kcal = avg ? macroCalories(avg) : 0;
    const row = (label, color, v, goal, kcalPer) => html`
      <div style="margin-bottom:10px">
        <div class="row between small"><span class="row"><i class="dot" style="background:var(${color})"></i><b>${label}</b></span><span>${fmt1(v)} / ${fmtInt(goal)} g${kcalPer && kcal ? html` <span class="faint">· ${Math.round((v * kcalPer / kcal) * 100)}% of kcal</span>` : ''}</span></div>
        <div class="bar"><span style="width:${Math.min(100, goal ? (v / goal) * 100 : 0)}%;background:var(${color})"></span></div>
      </div>`;
    setHTML($('#p-macros', root), html`
      <div class="card-head"><h2 class="card-title">Average macros</h2><span class="small muted">${avg ? `${avg.days} logged day${avg.days === 1 ? '' : 's'}` : ''}</span></div>
      ${avg ? html`${row('Protein', '--c-protein', avg.protein, g.protein, 4)}${row('Carbs', '--c-carbs', avg.carbs, g.carbs, 4)}${row('Fat', '--c-fat', avg.fat, g.fat, 9)}${row('Fiber', '--c-fiber', avg.fiber, g.fiber, 0)}`
        : html`<p class="small muted">Log meals to see your average macros.</p>`}`);
  };

  const renderStreak = () => {
    const s = computeStreak(state.loggedDates);
    const last28 = dateRange(addDays(today(), -27), today());
    const set = new Set(state.loggedDates);
    setHTML($('#p-streak', root), html`
      <div class="card-head"><h2 class="card-title">Logging streak</h2><span class="streak-pill">🔥 ${s.current}</span></div>
      <div class="cal" aria-label="Logged days in the last 4 weeks">${last28.map((d) => html`<div class="cal-day ${set.has(d) ? 'logged' : ''} ${d === today() ? 'today' : ''}" title="${formatDay(d)}"><span class="sr-only">${formatDay(d)} ${set.has(d) ? 'logged' : 'not logged'}</span>${parseISODate(d).getDate()}</div>`)}</div>
      <p class="small muted" style="margin-top:8px">Best streak: <b>${s.best} day${s.best === 1 ? '' : 's'}</b>. Your streak stays alive until the end of today.</p>`);
  };

  const renderAll = () => { renderTiles(); renderWeight(); renderNutrition(); renderStreak(); };

  const load = async () => {
    items = null;
    renderAll();
    try {
      const [rows] = await Promise.all([fetchItemsRange(start(), today()), fetchLoggedDates(), fetchWeights()]);
      items = rows;
      renderAll();
    } catch (e) {
      console.error('[NutriLog] progress', e);
      setHTML($('#p-cal', root), html`<div class="chart-empty">Couldn't load your data. <button type="button" class="link-btn" data-action="retry">Retry</button></div>`);
    }
  };

  disposers.push(bindActions(root, {
    range: (el) => {
      range = el.dataset.range;
      sessionStorage.setItem('nutrilog.progressRange', range);
      root.querySelectorAll('[data-action="range"]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.range === range)));
      load();
    },
    'log-weight': () => openWeightSheet(),
    'del-weight': async (el) => {
      const d = el.dataset.date;
      if (await confirmDialog({ title: 'Delete weigh-in?', message: `Remove the entry for ${formatDay(d)}?`, confirmLabel: 'Delete', danger: true })) {
        deleteWeight(d); toast('Weigh-in deleted.');
      }
    },
    calendar: () => openCalendar({ onPick: (d) => { state.date = d; navigate('dashboard'); } }),
    retry: () => load(),
  }));
  disposers.push(on('weights', () => { renderTiles(); renderWeight(); }));
  disposers.push(on('streak', () => { renderTiles(); renderStreak(); }));
  disposers.push(on('data-changed', () => load()));
  disposers.push(on('account', renderAll));
  load();
  return () => { disposers.forEach((d) => d()); weightDispose?.(); nutritionDisposers.forEach((d) => d()); };
}
