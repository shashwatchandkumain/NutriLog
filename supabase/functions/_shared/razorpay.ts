// Razorpay helpers for the billing and webhook functions. Keys live only in Edge Function secrets:
//   RAZORPAY_KEY_ID          rzp_test_… or rzp_live_… (public — sent to Checkout)
//   RAZORPAY_KEY_SECRET      secret — API calls and payment signatures
//   RAZORPAY_WEBHOOK_SECRET  secret — webhook signatures (set in Razorpay → Webhooks)
import { env, HttpError } from './http.ts';

export const KEY_ID = env('RAZORPAY_KEY_ID');
const KEY_SECRET = env('RAZORPAY_KEY_SECRET');
export const MODE: 'test' | 'live' = KEY_ID.startsWith('rzp_live_') ? 'live' : 'test';
export const razorpayReady = () => !!(KEY_ID && KEY_SECRET);

const enc = new TextEncoder();

/** Lower-case hex HMAC-SHA256. */
export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Checkout success for a subscription: HMAC(payment_id + "|" + subscription_id, key secret). */
export async function verifySubscriptionPayment(paymentId: string, subscriptionId: string, signature: string, secret = KEY_SECRET): Promise<boolean> {
  if (!secret || !paymentId || !subscriptionId || !signature) return false;
  return safeEqual(await hmacHex(secret, `${paymentId}|${subscriptionId}`), String(signature));
}

/** Webhook: HMAC(raw body, webhook secret) in the X-Razorpay-Signature header. */
export async function verifyWebhook(rawBody: string, signature: string, secret = env('RAZORPAY_WEBHOOK_SECRET')): Promise<boolean> {
  if (!secret || !signature) return false;
  return safeEqual(await hmacHex(secret, rawBody), signature);
}

/** Amount charged in paise: price + GST, rounded to the paisa. */
export const withGst = (pricePaise: number, gstRate: number) => Math.round(pricePaise * (1 + Number(gstRate)));

/** Razorpay REST call with Basic auth. Throws a user-safe HttpError on failure. */
export async function razorpay<T = Record<string, unknown>>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
  if (!razorpayReady()) throw new HttpError(503, 'payments_unavailable', 'Payments are not available yet.');
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: { Authorization: `Basic ${btoa(`${KEY_ID}:${KEY_SECRET}`)}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new HttpError(502, 'payment_provider', "Couldn't reach the payment provider. Please try again.",
      `Razorpay ${method} ${path} → ${res.status}: ${JSON.stringify(data).slice(0, 400)}`);
  }
  return data as T;
}

export interface RazorpaySubscription {
  id: string; plan_id: string; status: string; start_at?: number | null; current_start?: number | null; current_end?: number | null;
  ended_at?: number | null; notes?: Record<string, string> | []; short_url?: string; has_scheduled_changes?: boolean;
}

const ts = (s?: number | null) => (s ? new Date(s * 1000).toISOString() : null);

/** Fields of public.billing_subscriptions taken from a Razorpay subscription entity. */
export function rowFromEntity(e: RazorpaySubscription) {
  return { status: e.status, start_at: ts(e.start_at), current_start: ts(e.current_start), current_end: ts(e.current_end), ended_at: ts(e.ended_at), updated_at: new Date().toISOString() };
}
