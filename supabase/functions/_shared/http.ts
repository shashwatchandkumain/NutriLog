// HTTP helpers shared by all NutriLog Edge Functions: CORS, JSON responses, auth.
import { createClient, type SupabaseClient, type User } from 'npm:@supabase/supabase-js@2.117.2';

// Browsers may call these functions only from NutriLog's own site. Set ALLOWED_ORIGINS
// (comma-separated) to change it, e.g. to add http://localhost:8080 while developing. Never "*".
const DEFAULT_ORIGINS = ['https://shashwatchandkumain.github.io'];
const configured = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
export const ALLOWED_ORIGINS = configured.length ? configured : DEFAULT_ORIGINS;

/** CORS headers: the caller's origin if it is allowed, otherwise the site's own (so the browser blocks it). */
export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** Error response with a user-safe message. Technical details go to the function logs only. */
export function fail(req: Request, status: number, code: string, message: string, detail?: unknown): Response {
  if (detail !== undefined) console.error(`[${code}]`, detail);
  return json(req, { error: { code, message } }, status);
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, public userMessage: string, public detail?: unknown) {
    super(userMessage);
  }
}

export function env(name: string, ...fallbacks: string[]): string {
  for (const n of [name, ...fallbacks]) {
    const v = Deno.env.get(n);
    if (v) return v;
  }
  return '';
}

const SUPABASE_URL = env('SUPABASE_URL');
const SUPABASE_ANON_KEY = env('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY');
const SUPABASE_SERVICE_ROLE_KEY = env('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY');

/** Supabase client that acts as the calling user (RLS applies). */
export function userClient(req: Request): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Service-role client. Server-side only — bypasses RLS. Never return its data unfiltered. */
export function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Resolves the signed-in (non-anonymous) user from the request's bearer token, or throws 401. */
export async function requireUser(req: Request): Promise<{ user: User; supabase: SupabaseClient }> {
  const header = req.headers.get('Authorization') ?? '';
  const token = header.replace(/^Bearer\s+/i, '');
  if (!token) throw new HttpError(401, 'unauthorized', 'Please log in again.');
  const supabase = userClient(req);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, 'unauthorized', 'Please log in again.', error);
  if (data.user.is_anonymous) throw new HttpError(403, 'account_required', 'Please create an account to use this feature.');
  return { user: data.user, supabase };
}

/** Parses a JSON body with a size cap. */
export async function readJson<T = Record<string, unknown>>(req: Request, maxBytes = 4_000_000): Promise<T> {
  const len = Number(req.headers.get('Content-Length') ?? 0);
  if (len > maxBytes) throw new HttpError(413, 'too_large', 'That request is too large.');
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, 'too_large', 'That request is too large.');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, 'bad_json', 'Invalid request.');
  }
}

/** Wraps a handler with CORS preflight, method check and uniform error handling. */
export function serve(handler: (req: Request) => Promise<Response>) {
  Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
    if (req.method !== 'POST') return fail(req, 405, 'method_not_allowed', 'Method not allowed.');
    try {
      return await handler(req);
    } catch (e) {
      if (e instanceof HttpError) return fail(req, e.status, e.code, e.userMessage, e.detail ?? e.message);
      return fail(req, 500, 'internal', 'Something went wrong. Please try again.', e);
    }
  });
}

/** Per-user AI quota (see public.consume_ai_quota). Throws 429 when exceeded. */
export async function consumeAiQuota(supabase: SupabaseClient, kind: string): Promise<void> {
  const hourly = Number(env('AI_HOURLY_LIMIT') || 30);
  const daily = Number(env('AI_DAILY_LIMIT') || 150);
  const { data, error } = await supabase.rpc('consume_ai_quota', { p_kind: kind, p_hourly: hourly, p_daily: daily });
  if (error) throw new HttpError(500, 'quota_check_failed', 'Something went wrong. Please try again.', error);
  if (data !== true) {
    throw new HttpError(429, 'rate_limited', "You've reached the AI limit for now. Please try again later.");
  }
}

export interface Spend {
  plan: string;
  features: Record<string, unknown>;
  remaining: number;
  /** Gives the credits back (call when the AI request failed). */
  refund: () => Promise<void>;
}

/**
 * Spends the AI credits for `action` (public.ai_credit_costs) from the user's plan allowance.
 * Throws 402 'no_credits' when there aren't enough — the app then offers an upgrade. Also keeps
 * the hourly/daily abuse limit (consume_ai_quota).
 */
export async function spendCredits(supabase: SupabaseClient, userId: string, action: string): Promise<Spend> {
  await consumeAiQuota(supabase, action);
  const admin = adminClient();
  const { data, error } = await admin.rpc('consume_credits', { p_user: userId, p_action: action });
  if (error) throw new HttpError(500, 'credits_check_failed', 'Something went wrong. Please try again.', error);
  if (!data?.ok) {
    throw new HttpError(402, 'no_credits', data?.plan === 'pro_ai'
      ? "You've used this month's AI credits. They refill on the 1st — foods from the NutriLog database still log for free."
      : "You've used your AI credits for now. Upgrade for more — foods from the NutriLog database still log for free.");
  }
  let refunded = false;
  return {
    plan: data.plan, features: data.features ?? {}, remaining: data.remaining,
    refund: async () => {
      if (refunded) return;
      refunded = true;
      const { error: e } = await admin.rpc('refund_credits', { p_user: userId, p_period_key: data.period_key, p_credits: data.cost });
      if (e) console.error('[credits] refund failed', e.message);
    },
  };
}

/** Throws 403 'plan_required' unless the user's plan includes `feature`. */
export async function requireFeature(userId: string, feature: string, plan: 'pro' | 'pro_ai'): Promise<void> {
  const { data, error } = await adminClient().rpc('entitlement_for', { p_user: userId });
  if (error) throw new HttpError(500, 'plan_check_failed', 'Something went wrong. Please try again.', error);
  if (!data?.features?.[feature]) {
    throw new HttpError(403, 'plan_required', `This is a ${plan === 'pro_ai' ? 'Pro AI' : 'Pro'} feature. Upgrade to use it.`);
  }
}

/** Runs `fn` with the spent credits refunded if it throws. */
export async function withRefund<T>(spend: Spend, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    await spend.refund();
    throw e;
  }
}
