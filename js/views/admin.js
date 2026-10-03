// Admin (only for accounts in public.app_admins — the server checks every call): users & plans
// (admin-users.js), and the food database: how foods were resolved (database vs AI), new foods waiting for review, correction reports,
// suggested aliases, and merging duplicates.
import { html, setHTML, fmtInt, fmt1, formatDay } from '../lib/utils.js';
import { state } from '../store.js';
import { bindActions, toast, showError, confirmDialog, openSheet, $ } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { mountAdminUsers } from './admin-users.js';
import { adminOverview, adminSetStatus, adminReviewCorrection, adminMergeFoods, adminAddAlias, adminRejectAlias, searchGlobalFoods } from '../services/food-db.js';

const pct = (a, b) => (b ? `${fmtInt((a / b) * 100)}%` : '—');

export function mountAdmin(root) {
  let data = null;
  setHTML(root, html`<div class="page-head"><div><h1>Admin</h1><p class="small muted">Users & plans, the shared food database and AI usage</p></div></div>
    <div class="cards" id="ad-users" style="margin-bottom:14px"></div>
    <h2 class="section-title">Food database</h2>
    <div id="ad-body"><div class="skeleton" style="height:200px"></div></div>`);
  const body = $('#ad-body', root);

  if (!state.isAdmin) {
    setHTML(root, html`<div class="empty"><div class="empty-title">Admins only</div><a class="btn btn-secondary btn-sm" href="#/more">Back</a></div>`);
    return () => {};
  }
  mountAdminUsers($('#ad-users', root));

  const render = () => {
    const days = data.stats || [];
    const week = days.slice(0, 7).reduce((s, d) => ({ items: s.items + d.items, global: s.global + d.global_hits, external: s.external + d.external_hits,
      ai: s.ai + d.ai_items, calls: s.calls + d.ai_calls, avoided: s.avoided + d.ai_calls_avoided }), { items: 0, global: 0, external: 0, ai: 0, calls: 0, avoided: 0 });
    const food = (f) => html`<div class="review-item">
      <div class="row between wrap"><b>${f.name}</b><span class="tag ${f.status === 'needs_review' ? 'warn' : ''}">${f.status === 'needs_review' ? 'users disagree' : 'pending'}</span></div>
      <div class="small">per 100 ${f.base_unit}: <b>${fmtInt(f.calories)} kcal</b> · P ${fmt1(f.protein)} · C ${fmt1(f.carbs)} · F ${fmt1(f.fat)} · Fib ${fmt1(f.fiber)}</div>
      <div class="tiny muted">${f.source_type === 'ai_assisted' ? 'AI estimate' : f.source || f.source_type} · confidence ${f.confidence ?? '—'} · confirmed by ${f.submissions} user${f.submissions === 1 ? '' : 's'} · ${formatDay(String(f.created_at).slice(0, 10))}
        ${f.servings?.length ? html`<br>Servings: ${f.servings.map((s) => `${s.label} = ${fmt1(s.grams)} ${f.base_unit}`).join(' · ')}` : ''}</div>
      <div class="row wrap"><button type="button" class="btn btn-primary btn-sm" data-action="approve" data-id="${f.id}">${icon('check', 14)} Approve</button>
        <button type="button" class="btn btn-secondary btn-sm" data-action="merge" data-id="${f.id}">Merge into…</button>
        <button type="button" class="btn btn-ghost btn-sm" data-action="reject" data-id="${f.id}">Reject</button></div>
    </div>`;
    setHTML(body, html`<div class="dash-grid"><div class="cards">
      <section class="card" aria-label="Food resolution">
        <div class="card-head"><h2 class="card-title">${icon('database', 18)} Last 7 days</h2><span class="small muted">${fmtInt(data.totals?.foods || 0)} shared foods</span></div>
        <div class="tiles">
          <div class="tile"><div class="tile-label">Foods logged</div><div class="tile-value">${fmtInt(week.items)}</div></div>
          <div class="tile"><div class="tile-label">From the database</div><div class="tile-value">${pct(week.global, week.items)}</div><div class="tile-delta">${fmtInt(week.global)} foods</div></div>
          <div class="tile"><div class="tile-label">Product databases</div><div class="tile-value">${pct(week.external, week.items)}</div></div>
          <div class="tile"><div class="tile-label">AI estimates</div><div class="tile-value">${pct(week.ai, week.items)}</div><div class="tile-delta">${fmtInt(week.calls)} AI calls</div></div>
          <div class="tile"><div class="tile-label">AI calls avoided</div><div class="tile-value">${fmtInt(week.avoided)}</div><div class="tile-delta good">foods answered by the database</div></div>
        </div>
        ${days.length ? html`<table class="data-table" style="margin-top:12px"><thead><tr><th>Day</th><th>Foods</th><th>Database</th><th>Products</th><th>AI</th><th>AI calls</th></tr></thead>
          <tbody>${days.slice(0, 14).map((d) => html`<tr><td>${formatDay(d.day, { month: 'short', day: 'numeric' })}</td><td>${d.items}</td><td>${d.global_hits}</td><td>${d.external_hits}</td><td>${d.ai_items}</td><td>${d.ai_calls}</td></tr>`)}</tbody></table>`
          : html`<p class="small muted" style="margin-top:8px">No foods logged yet.</p>`}
      </section>
      <section class="card" aria-label="Review queue">
        <div class="card-head"><h2 class="card-title">New foods to review</h2><span class="small muted">${data.queue.length}</span></div>
        <p class="tiny muted">AI foods are shared automatically once two users confirm matching values. Review the ones still waiting, or where users disagree.</p>
        ${data.queue.length ? html`<div class="stack-sm">${data.queue.map(food)}</div>` : html`<p class="small muted">Nothing waiting.</p>`}
      </section>
    </div><div class="cards">
      <section class="card" aria-label="Correction reports">
        <div class="card-head"><h2 class="card-title">Correction reports</h2><span class="small muted">${data.corrections.length}</span></div>
        ${data.corrections.length ? html`<div class="stack-sm">${data.corrections.map((c) => html`<div class="review-item">
          <b>${c.food}</b>
          <div class="small">${Object.entries(c.suggested).map(([k, v]) => html`<span class="nw">${k}: ${fmt1(c.current[k])} → <b>${fmt1(v)}</b></span> `)}</div>
          ${c.reason ? html`<div class="tiny muted">“${c.reason}”</div>` : ''}
          <div class="row"><button type="button" class="btn btn-primary btn-sm" data-action="fix-ok" data-id="${c.id}">Apply</button><button type="button" class="btn btn-ghost btn-sm" data-action="fix-no" data-id="${c.id}">Dismiss</button></div>
        </div>`)}</div>` : html`<p class="small muted">No open reports.</p>`}
      </section>
      <section class="card" aria-label="Suggested aliases">
        <div class="card-head"><h2 class="card-title">Suggested names</h2></div>
        <p class="tiny muted">Names users typed for a food ("anda" → Boiled egg). They're added automatically once two users use the same one.</p>
        ${data.aliases.length ? html`<div class="stack-sm">${data.aliases.map((a) => html`<div class="row between wrap"><span>“${a.alias}” → <b>${a.food}</b> <span class="tiny muted">(${a.votes})</span></span>
          <span class="row"><button type="button" class="btn btn-secondary btn-sm" data-action="alias-ok" data-food="${a.food_id}" data-alias="${a.alias}">Add</button><button type="button" class="btn btn-ghost btn-sm" data-action="alias-no" data-key="${a.alias_key}">Ignore</button></span></div>`)}</div>`
          : html`<p class="small muted">No suggestions.</p>`}
      </section>
    </div></div>`);
  };

  const load = async () => {
    try { data = await adminOverview(); render(); } catch (e) { showError(e, 'admin'); setHTML(body, html`<div class="empty"><div class="empty-title">Couldn't load the admin data</div><button type="button" class="btn btn-secondary btn-sm" data-action="reload">Retry</button></div>`); }
  };
  const act = async (fn, msg) => { try { await fn(); toast(msg, 'success'); await load(); } catch (e) { showError(e, 'admin'); } };

  const pickMergeTarget = (from) => {
    const sheet = openSheet({ title: `Merge “${from.name}” into…` });
    setHTML(sheet.body, html`<div class="stack"><p class="small muted">The food that stays. Logged meals keep their own nutrition; the old name becomes an alias.</p>
      <input class="input" type="search" placeholder="Search shared foods" aria-label="Search shared foods" data-q><div class="food-list" data-res></div></div>`);
    let found = [];
    sheet.body.querySelector('[data-q]').addEventListener('input', async (e) => {
      found = (await searchGlobalFoods(e.target.value, 8).catch(() => [])).filter((f) => f.id !== from.id && f.status === 'verified');
      setHTML(sheet.body.querySelector('[data-res]'), html`${found.map((f) => html`<button type="button" class="menu-item" data-into="${f.id}"><b>${f.name}</b> <span class="tiny muted">${fmtInt(f.calories)} kcal / 100 ${f.base_unit}</span></button>`)}`);
    });
    sheet.body.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-into]');
      if (!b) return;
      const into = found.find((f) => f.id === b.dataset.into);
      sheet.close();
      if (await confirmDialog({ title: 'Merge foods?', message: `“${from.name}” will point to “${into.name}”.`, confirmLabel: 'Merge' })) {
        act(() => adminMergeFoods(from.id, into.id), 'Merged ✓');
      }
    });
  };

  const dispose = bindActions(root, {
    reload: load,
    approve: (el) => act(() => adminSetStatus(el.dataset.id, 'verified'), 'Shared with everyone ✓'),
    reject: async (el) => { if (await confirmDialog({ title: 'Reject this food?', message: 'It will not be shared. Users who logged it keep their entries.', confirmLabel: 'Reject', danger: true })) act(() => adminSetStatus(el.dataset.id, 'rejected'), 'Rejected'); },
    merge: (el) => pickMergeTarget(data.queue.find((f) => f.id === el.dataset.id)),
    'fix-ok': (el) => act(() => adminReviewCorrection(el.dataset.id, true), 'Correction applied ✓'),
    'fix-no': (el) => act(() => adminReviewCorrection(el.dataset.id, false), 'Dismissed'),
    'alias-ok': (el) => act(() => adminAddAlias(el.dataset.food, el.dataset.alias), 'Alias added ✓'),
    'alias-no': (el) => act(() => adminRejectAlias(el.dataset.key), 'Ignored'),
  });
  load();
  return dispose;
}
