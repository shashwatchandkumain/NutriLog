// Progress: goal progress, weight trend (with a 7-day average so single days don't mislead),
// calories, protein, body composition, average macros and the logging streak. Everything is
// computed from the user's own logged data — no demo numbers.
import { html, setHTML, fmtInt, fmt1, fmtNum, today, addDays, dateRange, formatDay, parseISODate, debounce } from '../lib/utils.js';
import { formatWeight, kgToLb, macroCalories, recommendTargets, trimNumber } from '../lib/nutrition.js';
import { totalsByDate, computeStreak, averageOfLoggedDays, sortWeights, weightChange, goalProgress, movingAverage, weightTrend } from '../lib/stats.js';
import { state, on, emit, currentGoals, weightUnit, effectiveProfile, historyDays, hasFeature } from '../store.js';
import { weeklyCard } from './weekly-report.js';
import { $, bindActions } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { barChart, lineChart } from '../ui/charts.js';
import { fetchItemsRange, fetchLoggedDates, fetchWeights } from '../services/data.js';
import { navigate } from '../router.js';
import { openScale, openCalendar } from './lazy.js';

const RANGES = { 7: { label: '7D', days: 7 }, 30: { label: '30D', days: 30 }, 90: { label: '90D', days: 90 }, 365: { label: '1Y', days: 365 }, all: { label: 'All', days: null } };

export function mountProgress(root) {
  const disposers = [];
  const chartDisposers = [];
  // Free shows the last 30 days; longer ranges are part of Pro.
  const locked = (k) => { const max = historyDays(); return max != null && (k === 'all' || Number(k) > max); };
  let range = sessionStorage.getItem('nutrilog.progressRange') || '30';
  if (!RANGES[range] || locked(range)) range = '30';
  let items = null;

  setHTML(root, html`
    <div class="page-head">
      <div><h1>Progress</h1><p class="small muted" id="p-sub">Your trends over time</p></div>
      <div class="row">
        <div class="segmented" role="group" aria-label="Time range">
          ${Object.entries(RANGES).map(([k, r]) => html`<button type="button" data-action="range" data-range="${k}" aria-pressed="${k === range}">${locked(k) ? '🔒 ' : ''}${r.label}</button>`)}
        </div>
        <button type="button" class="icon-btn" data-action="calendar" aria-label="Open calendar">${icon('calendar')}</button>
      </div>
    </div>
    <div class="dash-grid">
      <div class="cards">
        <section class="card" id="p-goal" aria-label="Goal progress"></section>
        <section class="card" aria-label="Weight trend"><div class="card-head"><h2 class="card-title">Weight</h2>
          <div class="row"><a class="small" href="#/measure">Weigh-ins →</a><button type="button" class="btn btn-primary btn-sm" data-action="measure">${icon('scale', 16)} Measure</button></div></div>
          <div id="p-weight"></div></section>
        <section class="card" aria-label="Calories"><div class="card-head"><h2 class="card-title">Calories</h2><span class="small muted" id="p-cal-note"></span></div><div id="p-cal"></div></section>
        <section class="card" aria-label="Protein"><div class="card-head"><h2 class="card-title">Protein</h2><span class="small muted" id="p-prot-note"></span></div><div id="p-prot"></div></section>
      </div>
      <div class="cards">
        <section class="card" id="p-report" aria-label="Weekly AI report"></section>
        <div class="tiles" id="p-tiles"></div>
        <section class="card" id="p-body" aria-label="Body composition"></section>
        <section class="card" id="p-macros" aria-label="Average macros"></section>
        <section class="card" id="p-streak" aria-label="Logging streak"></section>
      </div>
    </div>`);

  /** First day of the selected range ("All" = the first day with any data). */
  const start = () => {
    const days = RANGES[range].days;
    if (days) return addDays(today(), -(days - 1));
    const firsts = [state.loggedDates[0], sortWeights(state.weights)[0]?.recorded_on].filter(Boolean).sort();
    return firsts[0] && firsts[0] < today() ? firsts[0] : addDays(today(), -29);
  };
  const spanDays = () => Math.max(1, Math.round((parseISODate(today()) - parseISODate(start())) / 86400000) + 1);

  /** Buckets days for the bar charts: daily ≤ 31 days, weekly ≤ 3 months, monthly beyond. */
  function buckets(byDay) {
    const days = dateRange(start(), today());
    const n = days.length;
    const mk = (key, label, sub, ds, title) => {
      const avg = averageOfLoggedDays(byDay, ds);
      return { key, label, sub, title, calories: avg?.calories || 0, protein: avg?.protein || 0, logged: avg?.days || 0 };
    };
    if (n <= 31) return days.map((d) => { const dt = parseISODate(d); return mk(d, n <= 7 ? dt.toLocaleDateString(undefined, { weekday: 'short' }) : String(dt.getDate()), n <= 7 ? String(dt.getDate()) : '', [d], formatDay(d)); });
    const out = [];
    if (n <= 92) {
      for (let i = 0; i < days.length; i += 7) {
        const ds = days.slice(i, i + 7);
        out.push(mk(ds[0], formatDay(ds[0], { month: 'short', day: 'numeric' }).split(' ')[1] || '', formatDay(ds[0], { month: 'short' }), ds, `Week of ${formatDay(ds[0])} (average of logged days)`));
      }
      return out;
    }
    const byMonth = new Map();
    for (const d of days) { const k = d.slice(0, 7); if (!byMonth.has(k)) byMonth.set(k, []); byMonth.get(k).push(d); }
    for (const [k, ds] of byMonth) out.push(mk(k, parseISODate(`${k}-15`).toLocaleDateString(undefined, { month: 'short' }), n > 400 ? `'${k.slice(2, 4)}` : '', ds, `${parseISODate(`${k}-15`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })} (average of logged days)`));
    return out;
  }

  const renderGoal = () => {
    const unit = weightUnit();
    const p = effectiveProfile();
    const w = sortWeights(state.weights);
    const current = w.length ? Number(w[w.length - 1].weight_kg) : Number(p.weight_kg) || null;
    const startKg = Number(p.start_weight_kg) || (w.length ? Number(w[0].weight_kg) : null);
    const targetKg = Number(p.target_weight_kg) || null;
    const trend = weightTrend(w, addDays(today(), -27));
    const el = $('#p-goal', root);
    if (!current) {
      setHTML(el, html`<div class="empty compact"><div class="empty-title">No weigh-ins yet</div><div class="empty-sub">Measure or log your weight and your progress toward your goal will appear here.</div>
        <button type="button" class="btn btn-primary btn-sm" data-action="measure">Measure your weight</button></div>`);
      return;
    }
    const prog = targetKg ? goalProgress(startKg, current, targetKg) : null;
    const remaining = targetKg ? Math.abs(current - targetKg) : null;
    const reached = targetKg && remaining < 0.05;
    const plan = recommendTargets(p, { exerciseMode: state.prefs?.exercise_mode })?.plan;
    const pace = plan && ['dated', 'capped', 'default', 'past'].includes(plan.status) && plan.plannedWeeklyKg ? plan.plannedWeeklyKg : null;
    const fmtRate = (kgWeek) => `${kgWeek > 0 ? '+' : kgWeek < 0 ? '−' : '±'}${formatWeight(Math.abs(kgWeek), unit)}/week`;
    setHTML(el, html`
      <div class="card-head"><h2 class="card-title">${icon('target', 18)} Goal</h2><a class="small" href="#/settings?s=profile">Edit goal</a></div>
      <div class="goal-compare">
        <div><div class="eyebrow">Current</div><div class="big-number">${formatWeight(current, unit)}</div></div>
        <span class="goal-arrow" aria-hidden="true">${icon('chevronRight', 22)}</span>
        <div><div class="eyebrow">Goal</div><div class="big-number">${targetKg ? formatWeight(targetKg, unit) : '—'}</div></div>
      </div>
      ${targetKg ? html`
        <div class="bar goal-bar" role="progressbar" aria-label="Goal progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round((prog || 0) * 100)}"><span style="width:${(prog || 0) * 100}%"></span></div>
        <p class="small"><b>${reached ? 'Goal reached 🎉' : `${formatWeight(remaining, unit)} to go`}</b>${prog != null && !reached ? ` · ${fmtNum(prog * 100, 1)}% complete` : ''}${p.target_date ? ` · target date ${formatDay(p.target_date, { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}</p>`
        : html`<p class="small muted">Set a target weight (and optionally a date) in Settings → Profile to track your progress.</p>`}
      <dl class="kv" style="margin-top:12px">
        <dt>Starting weight</dt><dd>${startKg ? formatWeight(startKg, unit) : '—'}</dd>
        <dt>Change since start</dt><dd>${startKg ? `${current - startKg > 0 ? '+' : current - startKg < 0 ? '−' : '±'}${formatWeight(Math.abs(current - startKg), unit)}` : '—'}</dd>
        <dt>4-week trend</dt><dd>${trend == null ? 'needs 3+ weigh-ins over a week' : fmtRate(trend)}</dd>
        ${pace != null && targetKg && !reached ? html`<dt>Planned pace</dt><dd>${fmtRate(pace)}</dd>` : ''}
      </dl>
      ${plan?.projectedDate && targetKg && !reached && plan.status !== 'past' ? html`<p class="tiny faint" style="margin-top:8px">At the planned pace you'd reach your goal around ${formatDay(plan.projectedDate, { day: 'numeric', month: 'short', year: 'numeric' })}. This is an estimate — weekly weight naturally goes up and down.</p>` : ''}`);
  };

  const renderTiles = () => {
    const g = currentGoals();
    const unit = weightUnit();
    const streak = computeStreak(state.loggedDates);
    const byDay = items ? totalsByDate(items) : {};
    const avg = items ? averageOfLoggedDays(byDay, dateRange(start(), today())) : null;
    const w = sortWeights(state.weights);
    const ch = weightChange(w, spanDays());
    const lossGoal = state.profile?.goal === 'lose';
    setHTML($('#p-tiles', root), html`
      <div class="tile"><div class="tile-label">🔥 Current streak</div><div class="tile-value">${streak.current}<small> day${streak.current === 1 ? '' : 's'}</small></div><div class="tile-delta">Best ${streak.best} · ${streak.daysLogged} day${streak.daysLogged === 1 ? '' : 's'} logged</div></div>
      <div class="tile"><div class="tile-label">Avg calories / day</div><div class="tile-value">${avg ? fmtInt(avg.calories) : '—'}<small> kcal</small></div><div class="tile-delta">${avg ? `${avg.days} logged day${avg.days === 1 ? '' : 's'} · target ${fmtInt(g.calories)}` : 'No meals in this range'}</div></div>
      <div class="tile"><div class="tile-label">Avg protein / day</div><div class="tile-value">${avg ? fmtInt(avg.protein) : '—'}<small> g</small></div><div class="tile-delta ${avg && avg.protein >= g.protein * 0.9 ? 'good' : ''}">target ${fmtInt(g.protein)} g${avg && avg.protein >= g.protein * 0.9 ? ' ✓' : ''}</div></div>
      <div class="tile"><div class="tile-label">Weight change (${RANGES[range].label})</div><div class="tile-value">${ch ? `${ch.change > 0 ? '+' : ch.change < 0 ? '−' : ''}${formatWeight(Math.abs(ch.change), unit)}` : '—'}</div>
        <div class="tile-delta ${ch && ((lossGoal && ch.change < 0) || (!lossGoal && state.profile?.goal !== 'maintain' && ch.change > 0)) ? 'good' : ''}">${ch ? `since ${formatDay(ch.from.recorded_on, { month: 'short', day: 'numeric' })}` : 'Needs 2+ weigh-ins'}</div></div>`);
  };

  const renderWeight = () => {
    const unit = weightUnit();
    const toUnit = (v) => (unit === 'lb' ? kgToLb(v) : Number(v));
    const w = sortWeights(state.weights);
    const s = start();
    const inRange = w.filter((x) => x.recorded_on >= s);
    const pts = (inRange.length >= 2 ? inRange : w.slice(-Math.max(2, inRange.length))).map((x) => ({
      date: x.recorded_on, value: toUnit(x.weight_kg), label: formatDay(x.recorded_on, { month: 'short', day: 'numeric' }), title: formatDay(x.recorded_on),
    }));
    const from = pts[0]?.date || s;
    const average = pts.length >= 3 ? movingAverage(w).filter((a) => a.recorded_on >= from).map((a) => ({ date: a.recorded_on, value: toUnit(a.value) })) : null;
    const t = state.profile?.target_weight_kg;
    chartDisposers.push(lineChart($('#p-weight', root), pts, {
      target: t ? toUnit(Number(t)) : null, targetLabel: 'Goal', unit, format: (v) => trimNumber(v, 2), average,
      emptyText: 'Log your weight on at least two days to see your trend.', ariaLabel: 'Weight over time',
    }));
  };

  const renderBody = () => {
    const unit = weightUnit();
    const w = sortWeights(state.weights);
    const latest = [...w].reverse().find((x) => x.body_fat_pct != null);
    const el = $('#p-body', root);
    if (!latest) {
      setHTML(el, html`<div class="card-head"><h2 class="card-title">Body composition</h2></div>
        <p class="small muted">Measure with your smart scale (or log a weigh-in) with your height and age set in your profile to see estimated body fat, lean mass, body water and BMR.</p>`);
      return;
    }
    const s = start();
    const pts = w.filter((x) => x.body_fat_pct != null && x.recorded_on >= s).map((x) => ({
      date: x.recorded_on, value: Number(x.body_fat_pct), label: formatDay(x.recorded_on, { month: 'short', day: 'numeric' }), title: formatDay(x.recorded_on),
    }));
    const hr = [...w].reverse().find((x) => x.heart_rate_bpm);
    const history = hasFeature('body_history');
    setHTML(el, html`
      <div class="card-head"><h2 class="card-title">Body composition</h2><span class="tag">Estimates</span></div>
      <div class="tiles">
        <div class="tile"><div class="tile-label">Body fat</div><div class="tile-value">${fmtNum(latest.body_fat_pct, 1)}<small>%</small></div><div class="tile-delta">${latest.fat_mass_kg != null ? `${formatWeight(latest.fat_mass_kg, unit)} fat` : ''}</div></div>
        <div class="tile"><div class="tile-label">Lean mass</div><div class="tile-value">${latest.lean_mass_kg != null ? formatWeight(latest.lean_mass_kg, unit) : '—'}</div></div>
        <div class="tile"><div class="tile-label">BMI</div><div class="tile-value">${latest.bmi != null ? fmtNum(latest.bmi, 1) : '—'}</div></div>
        <div class="tile"><div class="tile-label">Heart rate</div><div class="tile-value">${hr ? html`${hr.heart_rate_bpm}<small> bpm</small>` : '—'}</div><div class="tile-delta">${hr ? formatDay(hr.recorded_on, { month: 'short', day: 'numeric' }) : 'from the smart scale'}</div></div>
      </div>
      ${history ? html`<div id="p-fat" style="margin-top:12px"></div>` : html`<button type="button" class="locked-chart" data-action="unlock-body">🔒 Body-fat trend over time is part of Pro</button>`}
      <p class="tiny faint" style="margin-top:6px">Body fat is estimated from weight, height, age and sex (Deurenberg); heart rate comes from the scale. Treat these as trends, not medical measurements.</p>`);
    if (history) chartDisposers.push(lineChart($('#p-fat', root), pts, { unit: '%', format: (v) => v.toFixed(1), emptyText: 'Two or more weigh-ins in this range will show your body-fat trend.', ariaLabel: 'Estimated body fat over time' }));
  };

  const renderNutrition = () => {
    const g = currentGoals();
    if (!items) {
      for (const id of ['#p-cal', '#p-prot']) setHTML($(id, root), html`<div class="skeleton" style="height:180px"></div><p class="tiny faint" style="margin-top:8px">Preparing your progress…</p>`);
      setHTML($('#p-macros', root), html`<div class="skeleton" style="height:120px"></div>`);
      return;
    }
    const byDay = totalsByDate(items);
    const b = buckets(byDay);
    const any = b.some((x) => x.logged);
    const n = spanDays();
    const note = n <= 31 ? 'per day' : n <= 92 ? 'weekly average' : 'monthly average';
    $('#p-cal-note', root).textContent = note;
    $('#p-prot-note', root).textContent = note;
    if (!any) {
      const empty = html`<div class="chart-empty">Keep logging for a few days and your progress will appear here.</div>`;
      setHTML($('#p-cal', root), empty);
      setHTML($('#p-prot', root), empty);
    } else {
      chartDisposers.push(barChart($('#p-cal', root), b.map((x) => ({ key: x.key, label: x.label, sub: x.sub, title: x.title, value: x.calories, className: x.calories > g.calories * 1.05 ? 'over' : '' })),
        { goal: g.calories, goalLabel: 'Target', unit: 'kcal', ariaLabel: 'Calories over time', onSelect: n <= 31 ? (d) => { state.date = d; navigate('dashboard'); } : null }));
      chartDisposers.push(barChart($('#p-prot', root), b.map((x) => ({ key: x.key, label: x.label, sub: x.sub, title: x.title, value: x.protein, className: 'protein' })),
        { goal: g.protein, goalLabel: 'Target', unit: 'g', ariaLabel: 'Protein over time', format: (v) => fmtInt(v) }));
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

  const renderAll = () => {
    chartDisposers.splice(0).forEach((d) => d());
    renderGoal(); renderTiles(); renderWeight(); renderBody(); renderNutrition(); renderStreak();
  };

  let loadSeq = 0;
  const load = async () => {
    const my = ++loadSeq;
    items = null;
    renderAll();
    try {
      const rows = await fetchItemsRange(start(), today());
      if (my !== loadSeq) return;
      items = rows;
      renderAll();
    } catch (e) {
      console.error('[NutriLog] progress', e);
      setHTML($('#p-cal', root), html`<div class="chart-empty">Couldn't load your data. <button type="button" class="link-btn" data-action="retry">Retry</button></div>`);
    }
  };

  disposers.push(bindActions(root, {
    range: (el) => {
      if (locked(el.dataset.range)) {
        emit('upgrade', { reason: 'plan_required', message: 'Progress beyond the last 30 days — 90 days, a year and all time — is part of Pro.' });
        return;
      }
      range = el.dataset.range;
      sessionStorage.setItem('nutrilog.progressRange', range);
      root.querySelectorAll('[data-action="range"]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.range === range)));
      load();
    },
    measure: () => openScale(),
    calendar: () => openCalendar({ onPick: (d) => { state.date = d; navigate('dashboard'); } }),
    retry: () => load(),
    'unlock-body': () => emit('upgrade', { reason: 'plan_required', message: 'Body-composition history is part of Pro.' }),
  }));
  const reportCard = weeklyCard($('#p-report', root));
  // The plan can arrive after the page opened: refresh the locks.
  disposers.push(on('plan', () => {
    reportCard(); renderBody();
    root.querySelectorAll('[data-action="range"]').forEach((b) => { b.textContent = `${locked(b.dataset.range) ? '🔒 ' : ''}${RANGES[b.dataset.range].label}`; });
    if (locked(range)) { range = '30'; load(); }
  }));
  disposers.push(on('weights', renderAll));
  disposers.push(on('streak', () => { renderTiles(); renderStreak(); }));
  disposers.push(on('data-changed', debounce(load, 500)));
  disposers.push(on('account', renderAll));
  fetchLoggedDates().catch(() => {});
  fetchWeights().catch(() => {});
  load();
  return () => { disposers.forEach((d) => d()); chartDisposers.splice(0).forEach((d) => d()); };
}
