// Admin → Users & plans: subscribers by plan, monthly revenue, recent payment events, Razorpay
// plan setup, and per-user tools (give a plan for N days, add AI credits). Every call is checked
// on the server (public.require_admin / is_admin).
import { html, setHTML, fmtInt, formatDay, debounce } from '../lib/utils.js';
import { toast, showError, withBusy, confirmDialog } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { sb } from '../services/supabase.js';
import { syncRazorpayPlans, PLAN_LABEL } from '../services/billing.js';
import { formatPhone } from '../lib/phone.js';
import { planStatusText } from './plans.js';

const rpc = async (name, args = {}) => {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return data;
};

export function mountAdminUsers(container) {
  let overview = null;
  let users = [];
  let query = '';

  const render = () => {
    const u = overview?.users || {};
    setHTML(container, html`
      <section class="card" aria-label="Subscriptions">
        <div class="card-head"><h2 class="card-title">${icon('star', 18)} Subscriptions</h2>
          <button type="button" class="btn btn-secondary btn-sm" data-sync>Set up Razorpay plans</button></div>
        <div class="tiles">
          <div class="tile"><div class="tile-label">Free</div><div class="tile-value">${fmtInt(u.free || 0)}</div></div>
          <div class="tile"><div class="tile-label">Pro</div><div class="tile-value">${fmtInt(u.pro || 0)}</div></div>
          <div class="tile"><div class="tile-label">Pro AI</div><div class="tile-value">${fmtInt(u.pro_ai || 0)}</div><div class="tile-delta">${fmtInt(u.trialing || 0)} on free trial</div></div>
          <div class="tile"><div class="tile-label">Monthly revenue</div><div class="tile-value">₹${fmtInt(overview?.mrr_rupees || 0)}</div><div class="tile-delta">before GST · ${fmtInt(u.past_due || 0)} payment${u.past_due === 1 ? '' : 's'} failing</div></div>
          <div class="tile"><div class="tile-label">AI credits used</div><div class="tile-value">${fmtInt(overview?.credits_this_month || 0)}</div><div class="tile-delta">this month</div></div>
        </div>
        ${overview?.recent?.length ? html`<p class="tiny muted" style="margin-top:8px">Recent payment events: ${overview.recent.slice(0, 6).map((e) => `${e.event.replace('subscription.', '')} (${formatDay(String(e.at).slice(0, 10), { day: 'numeric', month: 'short' })})`).join(' · ')}</p>` : ''}
      </section>
      <section class="card" aria-label="Users">
        <div class="card-head"><h2 class="card-title">Users</h2><span class="small muted">${users.length} shown</span></div>
        <input class="input" type="search" placeholder="Search by phone, email or name" aria-label="Search users" data-q value="${query}">
        <div class="stack-sm" style="margin-top:10px">${users.map((x) => html`<div class="review-item">
          <div class="row between wrap"><b>${x.name || x.email || 'No name'}</b>${x.admin ? html`<span class="tag ok">admin</span>` : ''}</div>
          <div class="small">${x.phone ? html`${formatPhone(x.phone)} ${x.phone_verified ? '✓' : html`<span class="muted">(not verified)</span>`}` : html`<span class="muted">no phone</span>`} · ${x.email || '—'}</div>
          <div class="small"><b>${planStatusText(x.entitlement)}</b> · ${fmtInt(x.entitlement.credits.remaining)}/${fmtInt(x.entitlement.credits.allowance)} credits left</div>
          <div class="tiny muted">Joined ${formatDay(String(x.created_at).slice(0, 10))}${x.last_sign_in_at ? ` · last seen ${formatDay(String(x.last_sign_in_at).slice(0, 10))}` : ''}</div>
          <div class="row wrap">
            <button type="button" class="btn btn-secondary btn-sm" data-grant="pro_ai" data-id="${x.id}">Give Pro AI · 30 days</button>
            <button type="button" class="btn btn-secondary btn-sm" data-grant="pro" data-id="${x.id}">Give Pro · 30 days</button>
            ${x.entitlement.source === 'grant' ? html`<button type="button" class="btn btn-ghost btn-sm" data-end="${x.id}">End given plan</button>` : ''}
            <button type="button" class="btn btn-ghost btn-sm" data-credits="${x.id}">+50 credits</button>
          </div></div>`)}</div>
      </section>`);
  };

  const loadUsers = async () => { users = await rpc('admin_users', { p_query: query, p_limit: 30 }); render(); };
  const load = async () => {
    try {
      [overview, users] = await Promise.all([rpc('admin_billing_overview'), rpc('admin_users', { p_query: query, p_limit: 30 })]);
      render();
    } catch (e) { showError(e, 'admin users'); }
  };
  const act = async (btn, fn, msg) => withBusy(btn, '…', async () => {
    try { await fn(); toast(msg, 'success'); await load(); } catch (e) { showError(e, 'admin'); }
  });

  container.addEventListener('input', debounce((e) => {
    if (!e.target.matches('[data-q]')) return;
    query = e.target.value.trim();
    loadUsers().then(() => {
      const box = container.querySelector('[data-q]');
      box?.focus(); box?.setSelectionRange(query.length, query.length);
    }).catch((err) => showError(err, 'search users'));
  }, 300));
  container.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.matches('[data-sync]')) {
      act(t, async () => {
        const r = await syncRazorpayPlans();
        toast(r.created.length ? `Created ${r.created.length} Razorpay plan${r.created.length === 1 ? '' : 's'} (${r.mode} mode).` : `Razorpay plans are up to date (${r.mode} mode).`, 'success', { duration: 7000 });
      }, 'Done');
    } else if (t.matches('[data-grant]')) {
      const who = users.find((x) => x.id === t.dataset.id);
      if (await confirmDialog({ title: `Give ${PLAN_LABEL[t.dataset.grant]}?`, message: `${who?.name || who?.email} gets ${PLAN_LABEL[t.dataset.grant]} free for 30 days. Nothing is charged.`, confirmLabel: 'Give plan' })) {
        act(t, () => rpc('admin_grant_plan', { p_user: t.dataset.id, p_plan: t.dataset.grant, p_days: 30, p_note: 'given by admin' }), 'Plan given ✓');
      }
    } else if (t.matches('[data-end]')) act(t, () => rpc('admin_end_grant', { p_user: t.dataset.end }), 'Given plan ended');
    else if (t.matches('[data-credits]')) act(t, () => rpc('admin_add_credits', { p_user: t.dataset.credits, p_credits: 50 }), '50 credits added ✓');
  });
  setHTML(container, html`<div class="skeleton" style="height:160px"></div>`);
  load();
}
