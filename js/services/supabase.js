// Supabase client (public URL + anon/publishable key only) and Edge Function calls.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';
import { CONFIG } from '../config.js';
import { UserError } from '../lib/utils.js';
import { emit } from '../store.js';

const url = String(CONFIG.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const key = String(CONFIG.SUPABASE_ANON_KEY || '').trim();

/** Refuses keys that must never ship to a browser (service role / secret keys). */
function isForbiddenKey(k) {
  if (k.startsWith('sb_secret_')) return true;
  const parts = k.split('.');
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      return payload.role === 'service_role';
    } catch { return false; }
  }
  return false;
}

export const configProblem =
  !/^https:\/\/.+/.test(url) || !key || key.startsWith('YOUR_') ? 'missing'
    : isForbiddenKey(key) ? 'secret-key'
      : null;

if (configProblem === 'secret-key') {
  console.error('[NutriLog] js/config.js contains a SERVICE ROLE / SECRET key. Remove it immediately and rotate it in Supabase → Project Settings → API Keys. Use the anon/publishable key instead.');
}

// The session is persisted by supabase-js in localStorage under its default key, so a
// session from the previous app version on this device is picked up too.
export const sb = configProblem ? null : createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
  realtime: { params: { eventsPerSecond: 5 } },
});

/** Base URL the auth emails redirect back to (works under /NutriLog/ on GitHub Pages). */
export const APP_URL = `${location.origin}${location.pathname.replace(/index\.html$/, '')}`;

/**
 * Calls a NutriLog Edge Function. Throws a UserError with a safe message on failure.
 * The user's session token is attached automatically; no secret ever leaves the server.
 */
export async function callFunction(name, body) {
  if (!sb) throw new UserError('NutriLog is not configured yet.');
  const { data, error } = await sb.functions.invoke(name, { body });
  if (!error) return data;
  let message = null;
  let code = null;
  let status = error.context?.status;
  try {
    const payload = await error.context?.json?.();
    message = payload?.error?.message || null;
    code = payload?.error?.code || null;
  } catch { /* non-JSON error body */ }
  // 4xx and 503 (AI unavailable) are handled conditions with a user message; others are bugs.
  console[status && (status < 500 || status === 503) ? 'warn' : 'error'](`[NutriLog] function ${name} failed`, status, error);
  if (!message) {
    if (status === 404) message = 'This feature is not available yet.';
    else if (error.name === 'FunctionsFetchError') message = "Couldn't reach the server. Check your connection and try again.";
    else message = 'Something went wrong. Please try again.';
  }
  const e = new UserError(message, error);
  e.status = status;
  e.code = code;
  // Out of AI credits, or a feature of a higher plan: the app offers an upgrade.
  if (code === 'no_credits' || code === 'plan_required') emit('upgrade', { reason: code, message });
  throw e;
}
