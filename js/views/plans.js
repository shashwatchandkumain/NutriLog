// Plans & billing: Free / Pro / Pro AI with launch prices (crossed-out list price + % off), the
// one-week Pro AI trial offer, checkout (Razorpay), the upgrade prompt and the plan summary used
// in Settings. Prices, credits and features come from the database via the billing function.
import { html, setHTML, fmtInt, formatDay } from '../lib/utils.js';
import { state, on } from '../store.js';
import { bindActions, toast, showError, withBusy, openSheet, confirmDialog } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { navigate } from '../router.js';
import { loadBilling, loadEntitlement, subscribe, cancelSubscription, rupees, percentOff, PLAN_LABEL } from '../services/billing.js';

const FEATURES = {
  free: (p) => [
    'Calories, macros, meals and water',
    'NutriLog food database — known foods need no AI',
    'Barcode scanner, My foods and voice logging',
    'Weight, activity and the Cult smart scale',
    'Progress for the last 30 days',
    `${fmtInt(p.credits_monthly)} AI credits a month`,
  ],
  pro: (p) => [
    'Everything in Free',
    `${fmtInt(p.credits_monthly)} AI credits a month`,
    'Weekly AI report — what to change next week',
    'Vitamins & minerals for every day',
    'Full progress history and body-composition trends',
  ],
  pro_ai: (p) => [
    'Everything in Pro',
    `${fmtInt(p.credits_monthly)} AI credits a month`,
    'AI meal plan for a day or a week + grocery list',
    'Choose Claude — the most accurate AI estimates',
    'The most AI for photos, coach and reports',
  ],
};

const priceOf = (b, plan, period) => b?.prices?.find((p) => p.plan === plan && p.period === period);

/** Plan name + status in plain words, e.g. "Pro AI · free trial until 10 Oct". */
export function planStatusText(e = state.entitlement) {
  if (!e || e.plan === 'free') return 'Free';
  const d = (iso) => (iso ? formatDay(String(iso).slice(0, 10), { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const name = PLAN_LABEL[e.plan];
  if (e.status === 'trialing') return `${name} · free trial ${e.cancel_at_period_end ? 'ends' : 'until'} ${d(e.trial_end)}${e.cancel_at_period_end ? ' (cancelled — no charge)' : ''}`;
  if (e.source === 'grant') return `${name} · until ${d(e.ends_at)}`;
  if (e.status === 'past_due') return `${name} · payment failed — retrying`;
  if (e.cancel_at_period_end) return `${name} · ends ${d(e.ends_at)}`;
  return `${name} · renews ${d(e.ends_at)}`;
}

/** "18 of 20 AI credits left · refills 1 Nov". */
export function creditsText(e = state.entitlement) {
  const c = e?.credits;
  if (!c) return '';
  return `${fmtInt(c.remaining)} of ${fmtInt(c.allowance)} AI credits left · ${e.status === 'trialing' ? 'for the trial' : `refills ${formatDay(String(c.resets_at).slice(0, 10), { day: 'numeric', month: 'short' })}`}`;
}

export function mountPlans(root) {
  let period = 'month';
  let b = state.billing;
  const disposers = [];

  const render = () => {
    const e = state.entitlement;
    const ready = !!b?.razorpay?.ready;
    const trialOk = ready && b?.trial?.eligible;
    const trialPrice = priceOf(b, 'pro_ai', 'month');
    const trialEnds = new Date(Date.now() + (b?.trialDays || 7) * 86400000);
    const plans = b?.plans || [];
    const card = (plan) => {
      const p = plans.find((x) => x.id === plan);
      if (!p) return '';
      const pr = plan === 'free' ? null : priceOf(b, plan, period);
      const current = e?.plan === plan && (plan === 'free' || e.period === period || e.source !== 'subscription');
      const yearlyMonthly = pr && period === 'year' ? Math.round(pr.price / 12) : null;
      return html`<section class="plan-card ${plan === 'pro' ? 'popular' : ''} ${current ? 'current' : ''}" aria-label="${p.name}">
        ${plan === 'pro' ? html`<span class="plan-flag">Most popular</span>` : ''}
        <h2 class="plan-name">${plan === 'pro_ai' ? '🤖 ' : plan === 'pro' ? '⭐ ' : ''}${p.name}</h2>
        ${pr ? html`
          <div class="plan-price-row"><s class="plan-list" aria-label="Was ${rupees(pr.list)}">${rupees(pr.list)}</s><span class="plan-off">${percentOff(pr.list, pr.price)}% OFF</span></div>
          <div class="plan-price"><b>${rupees(pr.price)}</b><span>/${period === 'month' ? 'month' : 'year'}</span></div>
          <div class="plan-gst">+ ${Math.round(pr.gstRate * 100)}% GST · ${rupees(pr.total)} total${yearlyMonthly ? html` · ≈ ${rupees(yearlyMonthly)}/month` : ''}</div>`
          : html`<div class="plan-price"><b>₹0</b><span>/forever</span></div><div class="plan-gst">No card needed</div>`}
        <ul class="plan-features">${FEATURES[plan](p).map((f) => html`<li>${icon('check', 16)}<span>${f}</span></li>`)}</ul>
        ${current ? html`<button type="button" class="btn btn-secondary btn-block" disabled>Your current plan</button>`
          : plan === 'free' ? html`<button type="button" class="btn btn-ghost btn-block" disabled>${e?.plan && e.plan !== 'free' ? 'Included in your plan' : 'Your current plan'}</button>`
            : html`<button type="button" class="btn ${plan === 'pro' ? 'btn-primary' : 'btn-secondary'} btn-block" data-action="buy" data-plan="${plan}" ${ready && pr?.ready ? '' : 'disabled'}>${ready && pr?.ready ? `Get ${p.name}` : 'Launching soon'}</button>`}
      </section>`;
    };
    setHTML(root, html`
      <div class="page-head"><div><h1>Plans</h1><p class="small muted">Track. Understand. Improve.</p></div></div>
      ${e ? html`<div class="card plan-now"><div class="grow"><div class="eyebrow">Your plan</div><b>${planStatusText(e)}</b><div class="small muted">${creditsText(e)}</div></div>
        ${e.source === 'subscription' || e.source === 'trial' ? html`<a class="btn btn-ghost btn-sm" href="#/settings?s=billing">Manage</a>` : ''}</div>` : ''}
      ${trialOk && trialPrice ? html`<section class="offer" aria-label="Exclusive offer">
        <div class="offer-tag">EXCLUSIVE OFFER</div>
        <h2>1 week of Pro AI — free</h2>
        <p>Everything in Pro AI for 7 days: 150 AI credits, meal plans, weekly report and Claude. Set up UPI autopay or a card — <b>₹0 today</b>.
          Then <s>${rupees(trialPrice.list)}</s> ${rupees(trialPrice.price)} + GST (${rupees(trialPrice.total)})/month from ${formatDay(trialEnds.toISOString().slice(0, 10), { day: 'numeric', month: 'short' })} unless you cancel before — one tap in Settings.</p>
        <button type="button" class="btn btn-primary btn-lg" data-action="trial">${icon('sparkles', 18)} Start my free week</button>
        <p class="tiny">One free trial per phone number and email. Your bank may show a small authorisation that is reversed.</p>
      </section>` : ''}
      ${!b ? html`<div class="skeleton" style="height:260px"></div>` : html`
        ${ready ? '' : html`<div class="banner"><span aria-hidden="true">🚀</span><div class="grow"><b>Paid plans are launching soon</b>Prices below are our launch offer. Everything in Free works now.</div></div>`}
        <div class="row" style="justify-content:center;margin:6px 0 14px">
          <div class="segmented" role="group" aria-label="Billing period">
            <button type="button" data-action="period" data-period="month" aria-pressed="${period === 'month'}">Monthly</button>
            <button type="button" data-action="period" data-period="year" aria-pressed="${period === 'year'}">Yearly <span class="plan-save">save 44%</span></button>
          </div>
        </div>
        <div class="plan-grid">${card('free')}${card('pro')}${card('pro_ai')}</div>
        <section class="card" style="margin-top:14px" aria-label="AI credits">
          <h2 class="card-title">What uses AI credits</h2>
          <p class="small muted" style="margin:6px 0 10px">Foods already in the NutriLog database, My foods, barcodes and manual entries are always free. Credits refill on the 1st of each month.</p>
          <table class="data-table"><tbody>${(b.costs || []).filter((c) => !['food_parse', 'food_estimate', 'food_text'].includes(c.action)).map((c) => html`<tr><td>${c.label}</td><td>${c.credits} credit${c.credits === 1 ? '' : 's'}</td></tr>`)}
            <tr><td>A typed or spoken meal with foods the database doesn't know</td><td>1–2 credits</td></tr></tbody></table>
        </section>
        <p class="tiny faint center" style="margin-top:12px">Prices in Indian rupees; 18% GST is added at checkout. Plans renew automatically until you cancel in Settings → Plan & billing; you keep your plan until the end of the period you paid for.</p>`}`);
  };

  const buy = async (btn, opts) => withBusy(btn, 'Opening payment…', async () => {
    try {
      const ent = await subscribe(opts);
      toast(opts.trial ? `Your free week of Pro AI has started ✓ — ends ${formatDay(String(ent.trial_end).slice(0, 10), { day: 'numeric', month: 'short' })}` : `Welcome to ${PLAN_LABEL[opts.plan]} ✓`, 'success', { duration: 6000 });
    } catch (e) {
      if (e?.dismissed) toast('Payment not completed — nothing was charged.');
      else showError(e, 'subscribe');
    }
    render();
  });

  disposers.push(bindActions(root, {
    period: (el) => { period = el.dataset.period; render(); },
    buy: (el) => buy(el, { plan: el.dataset.plan, period }),
    trial: (el) => buy(el, { trial: true }),
  }));
  disposers.push(on('plan', () => { b = state.billing; render(); }));
  render();
  loadBilling().then((x) => { b = x; render(); }).catch((e) => { showError(e, 'plans'); });
  return () => disposers.forEach((d) => d());
}

/** "You've used your AI credits" / "This is a Pro feature" — with the way to upgrade. */
export function openUpgrade({ reason, message } = {}) {
  const sheet = openSheet({ title: reason === 'no_credits' ? 'Out of AI credits' : 'Upgrade to unlock' });
  const e = state.entitlement;
  setHTML(sheet.body, html`<div class="stack">
    <p>${message || 'This feature is part of a paid plan.'}</p>
    <p class="small muted" data-credits>${e?.credits ? creditsText(e) : ''}</p>
    <div class="upgrade-row">
      <div><b>⭐ Pro</b><span class="small muted">150 credits · weekly report · vitamins</span></div>
      <div><b>🤖 Pro AI</b><span class="small muted">600 credits · meal plans · Claude</span></div>
    </div>
    <a class="btn btn-primary btn-block btn-lg" href="#/plans" data-go>See plans${state.billing?.trial?.eligible ? ' — first week free' : ''}</a>
    <p class="tiny faint center">Foods in the NutriLog database, My foods, barcodes and manual entries stay free.</p>
  </div>`);
  sheet.body.querySelector('[data-go]').addEventListener('click', () => sheet.close());
  loadEntitlement().then((fresh) => { const el = sheet.body.querySelector('[data-credits]'); if (el && fresh) el.textContent = creditsText(fresh); }).catch(() => {});
}

/** The "Plan & billing" section in Settings. */
export function billingSection(container) {
  const render = () => {
    const e = state.entitlement;
    const paid = e && (e.source === 'subscription' || e.source === 'trial');
    const pct = e?.credits?.allowance ? Math.min(100, (e.credits.remaining / e.credits.allowance) * 100) : 0;
    setHTML(container, html`
      <div class="setting-row"><div><div class="t">${e ? planStatusText(e) : 'Loading…'}</div><div class="d">${creditsText(e)}</div></div>
        <a class="btn btn-primary btn-sm" href="#/plans">${e?.plan === 'pro_ai' ? 'See plans' : 'Upgrade'}</a></div>
      ${e?.credits ? html`<div class="bar" role="progressbar" aria-label="AI credits left" aria-valuemin="0" aria-valuemax="${e.credits.allowance}" aria-valuenow="${e.credits.remaining}"><span style="width:${pct}%"></span></div>` : ''}
      ${paid && !e.cancel_at_period_end ? html`<div class="setting-row"><div><div class="t">${e.status === 'trialing' ? 'Cancel free trial' : 'Cancel subscription'}</div>
        <div class="d">${e.status === 'trialing' ? "You won't be charged. Pro AI stays until the trial ends." : 'You keep your plan until the end of the period you paid for.'}</div></div>
        <button type="button" class="btn btn-secondary btn-sm" data-cancel-sub>Cancel</button></div>` : ''}`);
    container.querySelector('[data-cancel-sub]')?.addEventListener('click', async (ev) => {
      const trial = e.status === 'trialing';
      if (!(await confirmDialog({ title: trial ? 'Cancel your free trial?' : 'Cancel your subscription?',
        message: trial ? 'Your autopay mandate is cancelled and nothing is charged. You keep Pro AI until the trial ends.' : `No further payments. You keep ${PLAN_LABEL[e.plan]} until ${planStatusText(e).split('renews ')[1] || 'the end of the period'}.`,
        confirmLabel: trial ? 'Cancel trial' : 'Cancel subscription', cancelLabel: 'Keep it', danger: true }))) return;
      await withBusy(ev.target, 'Cancelling…', async () => {
        try { await cancelSubscription(); toast(trial ? 'Trial cancelled — you will not be charged.' : 'Subscription cancelled.', 'success'); } catch (err) { showError(err, 'cancel'); }
      });
    });
  };
  render();
  const off = on('plan', render);
  loadEntitlement().catch(() => {});
  return off;
}

export const goToPlans = () => navigate('plans');
