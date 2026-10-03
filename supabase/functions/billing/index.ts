// POST /functions/v1/billing — subscriptions with Razorpay.
//   { action: 'status' }                                   plans, prices, the user's plan, credits, trial eligibility
//   { action: 'subscribe', plan, period, trial? }          creates a Razorpay subscription → Checkout opens it
//   { action: 'verify', razorpay_payment_id, razorpay_subscription_id, razorpay_signature }
//   { action: 'cancel' }                                   cancels at the end of the period (a trial: right away, no charge)
//   { action: 'sync_plans' }                               admin: creates missing Razorpay plans for the current prices
// Billing rows are written only here and by razorpay-webhook (service role); users can only read them.
import { adminClient, env, HttpError, json, readJson, requireUser, serve } from '../_shared/http.ts';
import { KEY_ID, MODE, razorpay, razorpayReady, type RazorpaySubscription, rowFromEntity, verifySubscriptionPayment, withGst } from '../_shared/razorpay.ts';

const TRIAL_DAYS = 7;
const phoneVerificationOn = () => env('PHONE_VERIFICATION') === 'on';
const PERIOD_NAME = { month: 'monthly', year: 'yearly' } as const;

interface PriceRow { plan_id: string; period: 'month' | 'year'; list_paise: number; price_paise: number; gst_rate: number; razorpay_plan_ids: Record<string, string>; plans: { name: string } }

serve(async (req) => {
  const { user, supabase } = await requireUser(req);
  const body = await readJson<Record<string, unknown>>(req, 10_000);
  const admin = adminClient();

  const prices = async (): Promise<PriceRow[]> => {
    const { data, error } = await admin.from('plan_prices').select('plan_id, period, list_paise, price_paise, gst_rate, razorpay_plan_ids, plans(name)').eq('active', true);
    if (error) throw new HttpError(500, 'prices', 'Something went wrong. Please try again.', error);
    return data as unknown as PriceRow[];
  };
  const entitlement = async () => (await admin.rpc('entitlement_for', { p_user: user.id })).data;
  const eligibility = async () => (await admin.rpc('trial_eligibility_for', { p_user: user.id, p_require_verified: phoneVerificationOn() })).data;
  const planKey = (p: PriceRow) => `${MODE}:${withGst(p.price_paise, p.gst_rate)}`;

  switch (body.action) {
    case 'status': {
      const [list, ent, trial, { data: plans }, { data: costs }] = await Promise.all([prices(), entitlement(), eligibility(),
        admin.from('plans').select('id, name, rank, credits_monthly, trial_credits, features').order('rank'),
        admin.from('ai_credit_costs').select('action, credits, label').order('credits')]);
      return json(req, {
        razorpay: { ready: razorpayReady(), keyId: razorpayReady() ? KEY_ID : null, mode: MODE },
        phoneVerification: phoneVerificationOn(), trialDays: TRIAL_DAYS,
        plans, costs, entitlement: ent, trial,
        prices: list.map((p) => ({ plan: p.plan_id, period: p.period, list: p.list_paise, price: p.price_paise, gstRate: Number(p.gst_rate),
          total: withGst(p.price_paise, p.gst_rate), ready: !!p.razorpay_plan_ids?.[planKey(p)] })),
      });
    }

    case 'subscribe': {
      if (!razorpayReady()) throw new HttpError(503, 'payments_unavailable', 'Payments are launching soon.');
      const trial = body.trial === true;
      const plan = trial ? 'pro_ai' : String(body.plan);
      const period = trial ? 'month' : String(body.period);
      const row = (await prices()).find((p) => p.plan_id === plan && p.period === period);
      if (!row) throw new HttpError(400, 'bad_plan', 'That plan is not available.');
      const rzpPlan = row.razorpay_plan_ids?.[planKey(row)];
      if (!rzpPlan) throw new HttpError(503, 'plans_not_synced', 'Payments are being set up. Please try again soon.', `missing Razorpay plan ${planKey(row)}`);
      const ent = await entitlement();
      if (trial) {
        const el = await eligibility();
        if (!el?.eligible) {
          throw new HttpError(409, `trial_${el?.reason}`, {
            no_phone: 'Add your phone number to start the free trial.',
            phone_unverified: 'Verify your phone number on WhatsApp to start the free trial.',
            phone_used: 'This phone number has already used the free trial.',
            email_used: 'This email has already used the free trial.',
            already_subscribed: 'The free trial is for new subscribers.',
          }[el?.reason as string] ?? 'The free trial is not available.');
        }
      } else if (ent?.source === 'subscription' && ent.plan === plan && ent.period === period && !ent.cancel_at_period_end) {
        throw new HttpError(409, 'already_on_plan', "You're already on this plan.");
      }
      const { data: profile } = await admin.from('profiles').select('display_name, phone').eq('id', user.id).maybeSingle();
      const sub = await razorpay<RazorpaySubscription>('POST', '/subscriptions', {
        plan_id: rzpPlan, total_count: period === 'month' ? 120 : 10, quantity: 1, customer_notify: 1,
        ...(trial ? { start_at: Math.floor(Date.now() / 1000) + TRIAL_DAYS * 86400 } : {}),
        notes: { user_id: user.id, plan, period, trial: String(trial) },
      });
      const { error } = await admin.from('billing_subscriptions').insert({ id: sub.id, user_id: user.id, plan_id: plan, period, is_trial: trial, mode: MODE, ...rowFromEntity(sub) });
      if (error) throw new HttpError(500, 'save_failed', 'Something went wrong. Please try again.', error);
      return json(req, {
        subscriptionId: sub.id, keyId: KEY_ID, trial, amount: withGst(row.price_paise, row.gst_rate),
        name: 'NutriLog', description: trial ? `${TRIAL_DAYS}-day free trial of Pro AI, then ₹${(withGst(row.price_paise, row.gst_rate) / 100).toFixed(2)}/month`
          : `${row.plans.name} · ${PERIOD_NAME[period as 'month' | 'year']}`,
        prefill: { name: profile?.display_name ?? '', email: user.email ?? '', contact: profile?.phone ?? '' },
      });
    }

    case 'verify': {
      const paymentId = String(body.razorpay_payment_id ?? '');
      const subId = String(body.razorpay_subscription_id ?? '');
      if (!(await verifySubscriptionPayment(paymentId, subId, String(body.razorpay_signature ?? '')))) {
        throw new HttpError(400, 'bad_signature', "We couldn't confirm that payment. If you were charged, it will be refunded or activated within a few minutes.");
      }
      const { data: row } = await admin.from('billing_subscriptions').select('*').eq('id', subId).maybeSingle();
      if (!row || row.user_id !== user.id) throw new HttpError(404, 'not_found', 'Subscription not found.');
      const entity = await razorpay<RazorpaySubscription>('GET', `/subscriptions/${subId}`);
      await admin.from('billing_subscriptions').update(rowFromEntity(entity)).eq('id', subId);
      if (row.is_trial) {
        const { data: claimed } = await admin.rpc('claim_trial', { p_user: user.id, p_subscription: subId });
        if (!claimed) {
          // Someone else claimed this phone/email meanwhile: stop the subscription, no charge.
          await razorpay('POST', `/subscriptions/${subId}/cancel`, { cancel_at_cycle_end: 0 }).catch((e) => console.error('[billing] cancel', e));
          await admin.from('billing_subscriptions').update({ status: 'cancelled', start_at: new Date().toISOString() }).eq('id', subId);
          throw new HttpError(409, 'trial_used', 'This phone number or email has already used the free trial.');
        }
      }
      // A new plan replaces the old one straight away.
      const { data: others } = await admin.from('billing_subscriptions').select('id, status').eq('user_id', user.id).neq('id', subId)
        .in('status', ['created', 'authenticated', 'active', 'pending']);
      for (const o of others ?? []) {
        if (o.status !== 'created') await razorpay('POST', `/subscriptions/${o.id}/cancel`, { cancel_at_cycle_end: 0 }).catch((e) => console.error('[billing] cancel old', e));
        await admin.from('billing_subscriptions').update({ status: 'cancelled', current_end: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', o.id);
      }
      return json(req, { entitlement: await entitlement() });
    }

    case 'cancel': {
      const ent = await entitlement();
      if (ent?.source !== 'subscription' && ent?.source !== 'trial') throw new HttpError(400, 'nothing_to_cancel', "You don't have a subscription to cancel.");
      const { data: row } = await admin.from('billing_subscriptions').select('*').eq('id', ent.subscription_id).maybeSingle();
      if (!row) throw new HttpError(404, 'not_found', 'Subscription not found.');
      const duringTrial = row.is_trial && row.start_at && Date.parse(row.start_at) > Date.now();
      const entity = await razorpay<RazorpaySubscription>('POST', `/subscriptions/${row.id}/cancel`, { cancel_at_cycle_end: duringTrial ? 0 : 1 });
      await admin.from('billing_subscriptions').update({ ...rowFromEntity(entity), start_at: row.start_at, cancel_at_cycle_end: !duringTrial }).eq('id', row.id);
      return json(req, { entitlement: await entitlement() });
    }

    case 'sync_plans': {
      const { data: isAdmin } = await supabase.rpc('is_admin');
      if (!isAdmin) throw new HttpError(403, 'admins_only', 'Admins only.');
      const created: string[] = [];
      for (const p of await prices()) {
        if (p.razorpay_plan_ids?.[planKey(p)]) continue;
        const amount = withGst(p.price_paise, p.gst_rate);
        const plan = await razorpay<{ id: string }>('POST', '/plans', {
          period: PERIOD_NAME[p.period], interval: 1,
          item: { name: `NutriLog ${p.plans.name} (${PERIOD_NAME[p.period]})`, amount, currency: 'INR',
            description: `₹${(p.price_paise / 100).toFixed(2)} + ${Math.round(Number(p.gst_rate) * 100)}% GST` },
          notes: { plan_id: p.plan_id, period: p.period },
        });
        await admin.from('plan_prices').update({ razorpay_plan_ids: { ...p.razorpay_plan_ids, [planKey(p)]: plan.id } }).eq('plan_id', p.plan_id).eq('period', p.period);
        created.push(`${p.plan_id}/${p.period} → ${plan.id}`);
      }
      return json(req, { mode: MODE, created });
    }

    default:
      throw new HttpError(400, 'bad_action', 'Invalid request.');
  }
});
