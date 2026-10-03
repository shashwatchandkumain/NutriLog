// Plans, AI credits and payments. The user's plan comes from the database (public.my_entitlement);
// subscriptions are created and verified by the billing Edge Function and paid with Razorpay
// Checkout. Nothing here can change a plan by itself — the server decides.
import { sb, callFunction } from './supabase.js';
import { state, emit } from '../store.js';
import { UserError } from '../lib/utils.js';

const CACHE = 'nutrilog.entitlement';

/** The user's current plan and credits (refreshes state.entitlement). */
export async function loadEntitlement() {
  if (!sb || !state.user) return null;
  const { data, error } = await sb.rpc('my_entitlement');
  if (error) throw error;
  state.entitlement = data;
  try { localStorage.setItem(`${CACHE}.${state.user.id}`, JSON.stringify(data)); } catch { /* ignore */ }
  emit('plan');
  return data;
}

/** Last known plan on this device (instant start, offline). */
export function cachedEntitlement(userId) {
  try { return JSON.parse(localStorage.getItem(`${CACHE}.${userId}`)) || null; } catch { return null; }
}

let refreshTimer = null;
/** Re-reads credits shortly after an AI call. */
export function refreshEntitlementSoon(ms = 800) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => loadEntitlement().catch(() => {}), ms);
}

/** Plans, prices, credit costs, trial eligibility and whether payments are ready. */
export async function loadBilling() {
  const status = await callFunction('billing', { action: 'status' });
  state.billing = status;
  if (status?.entitlement) state.entitlement = status.entitlement;
  emit('plan');
  return status;
}

let checkoutJs = null;
function loadCheckout() {
  if (window.Razorpay) return Promise.resolve();
  checkoutJs ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = resolve;
    s.onerror = () => { checkoutJs = null; reject(new UserError("Couldn't load the payment page. Check your connection and try again.")); };
    document.head.appendChild(s);
  });
  return checkoutJs;
}

/**
 * Starts a subscription (or the free trial, which sets up an autopay mandate) and opens
 * Razorpay Checkout. Resolves with the new entitlement after the server verified the payment.
 */
export async function subscribe({ plan, period, trial = false }) {
  const s = await callFunction('billing', { action: 'subscribe', plan, period, trial });
  await loadCheckout();
  return new Promise((resolve, reject) => {
    const rzp = new window.Razorpay({
      key: s.keyId,
      subscription_id: s.subscriptionId,
      name: s.name,
      description: s.description,
      prefill: s.prefill,
      notes: { app: 'NutriLog' },
      theme: { color: '#0f766e' },
      handler: async (resp) => {
        try {
          const r = await callFunction('billing', { action: 'verify', ...resp });
          state.entitlement = r.entitlement;
          emit('plan');
          loadBilling().catch(() => {});
          resolve(r.entitlement);
        } catch (e) { reject(e); }
      },
      modal: { ondismiss: () => reject(Object.assign(new UserError('Payment was not completed.'), { dismissed: true })) },
    });
    rzp.on?.('payment.failed', (r) => reject(new UserError(r?.error?.description || 'The payment failed. Please try again or use another method.')));
    rzp.open();
  });
}

/** Cancels: a trial ends with no charge; a paid plan stays until the end of the period. */
export async function cancelSubscription() {
  const r = await callFunction('billing', { action: 'cancel' });
  state.entitlement = r.entitlement;
  emit('plan');
  return r.entitlement;
}

/** Admin: creates the Razorpay plans for the current prices. */
export const syncRazorpayPlans = () => callFunction('billing', { action: 'sync_plans' });

// ── Display helpers ──────────────────────────────────────────────────────
export const rupees = (paise) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: paise % 100 ? 2 : 0, minimumFractionDigits: paise % 100 ? 2 : 0 })}`;
export const percentOff = (list, price) => Math.round((1 - price / list) * 100);
export const PLAN_LABEL = { free: 'Free', pro: 'Pro', pro_ai: 'Pro AI' };
