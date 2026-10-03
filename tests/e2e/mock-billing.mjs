// Billing part of the mock Supabase: plans, prices, AI credits, the trial ledger and Razorpay
// subscriptions, following the same rules as supabase/migrations/007_subscriptions.sql and the
// billing Edge Function. Razorpay itself is faked: payment signatures are real HMACs with a test
// secret that the fake Checkout (in the page) also knows.
import { createHmac, createHash } from 'node:crypto';

export const RZP_TEST_SECRET = 'rzp_test_secret_for_e2e';
const DAY = 86400000;

export const PLANS = {
  free: { id: 'free', name: 'Free', rank: 0, credits_monthly: 20, trial_credits: 0, features: { history_days: 30 } },
  pro: { id: 'pro', name: 'Pro', rank: 1, credits_monthly: 150, trial_credits: 0, features: { weekly_report: true, micros: true, body_history: true } },
  pro_ai: { id: 'pro_ai', name: 'Pro AI', rank: 2, credits_monthly: 600, trial_credits: 150, features: { weekly_report: true, micros: true, body_history: true, claude: true, meal_plan: true } },
};
const PRICES = [
  { plan: 'pro', period: 'month', list: 29900, price: 14900 }, { plan: 'pro', period: 'year', list: 358800, price: 99900 },
  { plan: 'pro_ai', period: 'month', list: 60000, price: 29900 }, { plan: 'pro_ai', period: 'year', list: 720000, price: 199900 },
];
export const COSTS = { food_parse: 1, food_estimate: 1, food_text: 2, food_image: 5, activity: 1, chat: 1, day_review: 1, suggest_meal: 1, weekly_report: 10, meal_plan_day: 5, meal_plan_week: 10 };
// The same labels as public.ai_credit_costs.
const LABELS = { food_parse: 'Understanding a typed or spoken meal', food_estimate: "Estimating foods the database doesn't know", food_text: 'Analysing a meal description',
  food_image: 'Analysing a food photo', activity: 'Estimating an activity', chat: 'Coach message', day_review: 'Review my day', suggest_meal: 'Suggest what to eat next',
  weekly_report: 'Weekly AI report', meal_plan_day: 'AI meal plan (1 day)', meal_plan_week: 'AI meal plan (7 days) + grocery list' };
const gst = (p) => Math.round(p * 1.18);
const hash = (kind, v) => createHash('sha256').update(`nutrilog-trial:${kind}:${String(v).trim().toLowerCase()}`).digest('hex');
const monthKey = () => { const d = new Date(Date.now() + 5.5 * 3600000); return `m:${d.toISOString().slice(0, 7)}`; };

export class MockBilling {
  constructor(backend) {
    this.backend = backend;
    this.subs = [];              // { id, user_id, plan_id, period, is_trial, status, start_at, current_end, cancel_at_cycle_end }
    this.grants = new Map();     // user → { plan_id, ends_at }
    this.usage = new Map();      // `${user}|${key}` → { used, bonus }
    this.claims = [];            // { phone_hash, email_hash, user_id }
    this.cancels = [];           // Razorpay cancel calls (subscription ids)
    this.ready = true;           // payments configured (Razorpay keys set)
    this.phoneVerification = false;
    this.seq = 0;
  }

  profile(uid) { return this.backend.db.profiles.find((p) => p.id === uid); }
  user(uid) { return this.backend.users.get(uid); }

  entitlement(uid) {
    const now = Date.now();
    let best = { plan: 'free', rank: 0, source: 'free', status: 'free', period: null, sub: null, ends: null, trialEnd: null, cancel: false };
    for (const r of this.subs.filter((s) => s.user_id === uid)) {
      if (r.is_trial && Date.parse(r.start_at) > now && ['authenticated', 'active', 'cancelled'].includes(r.status)) {
        if (2 >= best.rank) best = { plan: 'pro_ai', rank: 2, source: 'trial', status: 'trialing', period: r.period, sub: r.id, ends: r.start_at, trialEnd: r.start_at, cancel: r.status === 'cancelled' };
        continue;
      }
      const end = r.current_end ? Date.parse(r.current_end) : now + DAY;
      if ((['active', 'authenticated'].includes(r.status) && end > now) || (r.status === 'cancelled' && end > now)) {
        const rank = PLANS[r.plan_id].rank;
        if (rank > best.rank || (rank === best.rank && ['free', 'grant'].includes(best.source))) {
          best = { plan: r.plan_id, rank, source: 'subscription', status: r.status === 'cancelled' || r.cancel_at_cycle_end ? 'cancelling' : 'active', period: r.period, sub: r.id, ends: r.current_end, trialEnd: null, cancel: r.status === 'cancelled' || r.cancel_at_cycle_end };
        }
      }
    }
    const g = this.grants.get(uid);
    if (g && Date.parse(g.ends_at) > now && PLANS[g.plan_id].rank > best.rank) best = { plan: g.plan_id, rank: PLANS[g.plan_id].rank, source: 'grant', status: 'active', ends: g.ends_at };
    const p = PLANS[best.plan];
    const key = best.source === 'trial' ? `t:${best.sub}` : monthKey();
    const u = this.usage.get(`${uid}|${key}`) || { used: 0, bonus: 0 };
    const allowance = (best.source === 'trial' ? p.trial_credits : p.credits_monthly) + u.bonus;
    return { plan: p.id, plan_name: p.name, source: best.source, status: best.status, period: best.period ?? null, subscription_id: best.sub ?? null,
      ends_at: best.ends ?? null, trial_end: best.trialEnd ?? null, cancel_at_period_end: !!best.cancel, features: p.features,
      credits: { allowance, used: u.used, remaining: Math.max(allowance - u.used, 0), resets_at: new Date(now + 20 * DAY).toISOString(), period_key: key } };
  }

  /** consume_credits → { ok, cost, plan, features, refund() } */
  spend(uid, action) {
    const e = this.entitlement(uid);
    const cost = COSTS[action];
    const k = `${uid}|${e.credits.period_key}`;
    const u = this.usage.get(k) || { used: 0, bonus: 0 };
    if (u.used + cost > e.credits.allowance) return { ok: false, plan: e.plan, features: e.features };
    u.used += cost;
    this.usage.set(k, u);
    return { ok: true, cost, plan: e.plan, features: e.features, refund: () => { u.used = Math.max(0, u.used - cost); } };
  }

  eligibility(uid) {
    const pr = this.profile(uid);
    if (!pr?.phone) return { eligible: false, reason: 'no_phone' };
    if (this.phoneVerification && !pr.phone_verified) return { eligible: false, reason: 'phone_unverified' };
    if (this.claims.some((c) => c.phone_hash === hash('phone', pr.phone))) return { eligible: false, reason: 'phone_used' };
    if (this.claims.some((c) => c.email_hash === hash('email', this.user(uid)?.email))) return { eligible: false, reason: 'email_used' };
    if (this.subs.some((s) => s.user_id === uid && s.status !== 'created')) return { eligible: false, reason: 'already_subscribed' };
    return { eligible: true, reason: null };
  }

  status(uid) {
    return {
      razorpay: { ready: this.ready, keyId: this.ready ? 'rzp_test_E2E' : null, mode: 'test' }, phoneVerification: this.phoneVerification, trialDays: 7,
      plans: Object.values(PLANS), costs: Object.entries(COSTS).map(([action, credits]) => ({ action, credits, label: LABELS[action] || action })),
      entitlement: this.entitlement(uid), trial: this.eligibility(uid),
      prices: PRICES.map((p) => ({ plan: p.plan, period: p.period, list: p.list, price: p.price, gstRate: 0.18, total: gst(p.price), ready: true })),
    };
  }

  /** The billing Edge Function. Returns [status, body]. */
  handle(uid, body) {
    const err = (status, code, message) => [status, { error: { code, message } }];
    switch (body.action) {
      case 'status': return [200, this.status(uid)];
      case 'subscribe': {
        if (!this.ready) return err(503, 'payments_unavailable', 'Payments are launching soon.');
        const trial = body.trial === true;
        const plan = trial ? 'pro_ai' : body.plan;
        const period = trial ? 'month' : body.period;
        const price = PRICES.find((p) => p.plan === plan && p.period === period);
        if (!price) return err(400, 'bad_plan', 'That plan is not available.');
        if (trial) {
          const el = this.eligibility(uid);
          if (!el.eligible) return err(409, `trial_${el.reason}`, el.reason === 'phone_used' ? 'This phone number has already used the free trial.' : 'The free trial is not available.');
        }
        const id = `sub_E2E${++this.seq}`;
        this.subs.push({ id, user_id: uid, plan_id: plan, period, is_trial: trial, status: 'created', start_at: trial ? new Date(Date.now() + 7 * DAY).toISOString() : null, current_end: null, cancel_at_cycle_end: false });
        const pr = this.profile(uid);
        return [200, { subscriptionId: id, keyId: 'rzp_test_E2E', trial, amount: gst(price.price), name: 'NutriLog', description: trial ? '7-day free trial of Pro AI' : `${PLANS[plan].name}`,
          prefill: { name: pr?.display_name || '', email: this.user(uid)?.email || '', contact: pr?.phone || '' } }];
      }
      case 'verify': {
        const expected = createHmac('sha256', RZP_TEST_SECRET).update(`${body.razorpay_payment_id}|${body.razorpay_subscription_id}`).digest('hex');
        if (expected !== body.razorpay_signature) return err(400, 'bad_signature', "We couldn't confirm that payment.");
        const s = this.subs.find((x) => x.id === body.razorpay_subscription_id && x.user_id === uid);
        if (!s) return err(404, 'not_found', 'Subscription not found.');
        if (s.is_trial) {
          const pr = this.profile(uid);
          const ph = hash('phone', pr.phone), em = hash('email', this.user(uid).email);
          if (this.claims.some((c) => c.phone_hash === ph || c.email_hash === em)) { s.status = 'cancelled'; return err(409, 'trial_used', 'This phone number or email has already used the free trial.'); }
          this.claims.push({ phone_hash: ph, email_hash: em, user_id: uid });
          s.status = 'authenticated';
        } else {
          s.status = 'active';
          s.current_end = new Date(Date.now() + (s.period === 'year' ? 365 : 30) * DAY).toISOString();
        }
        for (const o of this.subs.filter((x) => x.user_id === uid && x.id !== s.id && ['created', 'authenticated', 'active', 'pending'].includes(x.status))) {
          if (o.status !== 'created') this.cancels.push(o.id);
          o.status = 'cancelled'; o.current_end = new Date().toISOString();
        }
        return [200, { entitlement: this.entitlement(uid) }];
      }
      case 'cancel': {
        const e = this.entitlement(uid);
        const s = this.subs.find((x) => x.id === e.subscription_id);
        if (!s) return err(400, 'nothing_to_cancel', "You don't have a subscription to cancel.");
        this.cancels.push(s.id);
        if (s.is_trial && Date.parse(s.start_at) > Date.now()) s.status = 'cancelled'; else s.cancel_at_cycle_end = true;
        return [200, { entitlement: this.entitlement(uid) }];
      }
      case 'sync_plans': return [200, { mode: 'test', created: [] }];
      default: return err(400, 'bad_action', 'Invalid request.');
    }
  }

  /** The billing RPCs. Returns undefined for anything else. */
  rpc(fn, body, uid) {
    if (fn === 'my_entitlement') return this.entitlement(uid);
    const admin = () => { if (!this.backend.foodDb.admins.has(uid)) throw Object.assign(new Error('admins only'), { code: '42501' }); };
    if (fn === 'admin_billing_overview') {
      admin();
      const users = { free: 0, pro: 0, pro_ai: 0, trialing: 0, past_due: 0 };
      for (const id of this.backend.users.keys()) { const e = this.entitlement(id); users[e.plan]++; if (e.status === 'trialing') users.trialing++; }
      return { users, mrr_rupees: 0, credits_this_month: 0, recent: [] };
    }
    if (fn === 'admin_users') {
      admin();
      const q = String(body.p_query || '').toLowerCase();
      return [...this.backend.users.values()].map((u) => ({ u, p: this.profile(u.id) }))
        .filter(({ u, p }) => !q || u.email?.toLowerCase().includes(q) || p?.phone?.includes(q) || p?.display_name?.toLowerCase().includes(q))
        .map(({ u, p }) => ({ id: u.id, email: u.email, phone: p?.phone ?? null, phone_verified: !!p?.phone_verified, name: p?.display_name ?? null, created_at: u.created_at,
          last_sign_in_at: null, admin: this.backend.foodDb.admins.has(u.id), entitlement: this.entitlement(u.id) }));
    }
    if (fn === 'admin_grant_plan') { admin(); this.grants.set(body.p_user, { plan_id: body.p_plan, ends_at: new Date(Date.now() + body.p_days * DAY).toISOString() }); return null; }
    if (fn === 'admin_end_grant') { admin(); this.grants.delete(body.p_user); return null; }
    if (fn === 'admin_add_credits') {
      admin();
      const k = `${body.p_user}|${this.entitlement(body.p_user).credits.period_key}`;
      const u = this.usage.get(k) || { used: 0, bonus: 0 };
      u.bonus += body.p_credits; this.usage.set(k, u);
      return null;
    }
    return undefined;
  }
}

/** Fake Razorpay Checkout for the page: "pays" by calling the handler with a real HMAC signature. */
export const FAKE_RAZORPAY = (secret) => {
  window.Razorpay = class {
    constructor(o) { this.o = o; window.__rzpLast = o; }
    on() {}
    async open() {
      if (window.__rzpDismiss) { setTimeout(() => this.o.modal?.ondismiss?.(), 50); return; }
      const pay = `pay_E2E${Date.now()}`;
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${pay}|${this.o.subscription_id}`)));
      const sig = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
      setTimeout(() => this.o.handler({ razorpay_payment_id: pay, razorpay_subscription_id: this.o.subscription_id, razorpay_signature: sig }), 100);
    }
  };
};
