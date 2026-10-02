// Small shared helpers: safe HTML templating, dates, numbers, ids, errors.

// ── Safe HTML ──────────────────────────────────────────────────────────────
// `html` is a tagged template that HTML-escapes every interpolated value unless it is
// itself an html`` result (or wrapped in trusted()). Use it for ALL innerHTML writes so
// user-, AI- and API-provided text can never inject markup.
class SafeHTML {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"'`]/g, (c) => ESC[c]);
const renderValue = (v) => {
  if (v == null || v === false) return '';
  if (v instanceof SafeHTML) return v.s;
  if (Array.isArray(v)) return v.map(renderValue).join('');
  return esc(v);
};
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += renderValue(values[i]) + strings[i + 1];
  return new SafeHTML(out);
}
/** Marks a string written by this codebase (never user data) as safe markup. */
export const trusted = (s) => new SafeHTML(String(s));
/** Sets element content from an html`` result. Refuses plain strings. */
export function setHTML(el, tpl) {
  if (!el) return;
  if (!(tpl instanceof SafeHTML)) throw new TypeError('setHTML expects an html`` template');
  el.innerHTML = tpl.s;
}

// ── Dates (local calendar days as YYYY-MM-DD) ─────────────────────────────
export function isoDate(d = new Date()) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
/** Parses YYYY-MM-DD as local noon (avoids DST/timezone off-by-one). */
export const parseISODate = (s) => new Date(`${s}T12:00:00`);
export function addDays(iso, n) { const d = parseISODate(iso); d.setDate(d.getDate() + n); return isoDate(d); }
export const today = () => isoDate(new Date());
export function daysBetween(a, b) { return Math.round((parseISODate(b) - parseISODate(a)) / 86400000); }
export function dateRange(startIso, endIso) {
  const out = [];
  for (let d = startIso; d <= endIso; d = addDays(d, 1)) out.push(d);
  return out;
}
export function formatDay(iso, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  return parseISODate(iso).toLocaleDateString(undefined, opts);
}
export function relativeDayLabel(iso) {
  const t = today();
  if (iso === t) return 'Today';
  if (iso === addDays(t, -1)) return 'Yesterday';
  if (iso === addDays(t, 1)) return 'Tomorrow';
  return formatDay(iso);
}

// ── Numbers ────────────────────────────────────────────────────────────────
export const fmtInt = (v) => Math.round(Number(v) || 0).toLocaleString();
export const fmt1 = (v) => { const r = Math.round((Number(v) || 0) * 10) / 10; return Number.isInteger(r) ? String(r) : r.toFixed(1); };
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/** Water amount for display: 750 → "750 ml", 1500 → "1.5 L". */
export function formatVolume(ml) {
  const v = Math.max(0, Math.round(Number(ml) || 0));
  return v >= 1000 ? `${(v / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} L` : `${v} ml`;
}
/** Locale-formatted number with up to `digits` decimals: 1872.75 → "1,872.8". Display only. */
export const fmtNum = (v, digits = 1) => (Number(v) || 0).toLocaleString(undefined, { maximumFractionDigits: digits });

// ── Misc ───────────────────────────────────────────────────────────────────
export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
/**
 * Deterministic UUID (SHA-256 of `text`, RFC 9562 version 8): the same input always gives the
 * same id, so importing the same file twice can never create duplicate rows.
 */
export async function uuidFrom(text) {
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)))).slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x80; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
export function mealTypeForTime(d = new Date()) {
  const h = d.getHours();
  if (h < 11) return 'breakfast';
  if (h < 16) return 'lunch';
  if (h < 18) return 'snack';
  return 'dinner';
}
export const MEAL_TYPES = [
  { id: 'breakfast', label: 'Breakfast', icon: '🌅' },
  { id: 'lunch', label: 'Lunch', icon: '🍛' },
  { id: 'snack', label: 'Snacks', icon: '🍎' },
  { id: 'dinner', label: 'Dinner', icon: '🌙' },
];

// ── Errors ─────────────────────────────────────────────────────────────────
export const GENERIC_ERROR = 'Something went wrong. Please try again.';

/**
 * Converts any thrown value into a short, user-safe message. The technical details are
 * logged to the console for debugging; users never see raw error text.
 */
export function friendlyError(err, context = '') {
  const msg = String(err?.message || err?.error_description || err || '').toLowerCase();
  const status = err?.status || err?.context?.status;
  const code = err?.code || '';
  // Handled, user-caused failures are warnings; anything unexpected is an error.
  const expected = !!err?.userMessage || !navigator.onLine || (status >= 400 && status < 500) ||
    /invalid login credentials|email not confirmed|already registered|password should be|failed to fetch/.test(msg);
  console[expected ? 'warn' : 'error'](`[NutriLog]${context ? ' ' + context + ':' : ''}`, err);
  if (!navigator.onLine || msg.includes('failed to fetch') || msg.includes('networkerror') || msg.includes('load failed')) {
    return "You're offline or the connection failed. Please check your internet and try again.";
  }
  if (msg.includes('invalid login credentials')) return 'Email or password is incorrect.';
  if (msg.includes('email not confirmed')) return 'Please confirm your email address first. Check your inbox for the link.';
  if (msg.includes('already registered') || code === 'user_already_exists') return 'An account with this email already exists. Try logging in.';
  if (msg.includes('password should be') || code === 'weak_password') return 'Please choose a stronger password (at least 8 characters).';
  if (msg.includes('jwt expired') || msg.includes('session') && msg.includes('expired') || code === 'session_expired') return 'Your session expired. Please log in again.';
  if (status === 429 || msg.includes('rate limit') || msg.includes('too many')) return 'Too many requests. Please wait a moment and try again.';
  if (err?.userMessage) return err.userMessage;
  return GENERIC_ERROR;
}

/** Error carrying a message that is safe to show to users. */
export class UserError extends Error {
  constructor(userMessage, cause) { super(userMessage); this.userMessage = userMessage; this.cause = cause; }
}
