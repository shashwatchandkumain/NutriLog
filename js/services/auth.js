// Authentication with Supabase Auth: email + password, magic link, password reset,
// recovery codes (via Edge Function), optional Google OAuth. Sessions persist and refresh
// automatically, so reopening the site restores the user without logging in again.
import { sb, APP_URL, callFunction } from './supabase.js';
import { UserError } from '../lib/utils.js';
import { toE164, looksLikePhone } from '../lib/phone.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function validateEmail(email) {
  const e = String(email || '').trim();
  if (!EMAIL_RE.test(e)) throw new UserError('Enter a valid email address.');
  return e.toLowerCase();
}

export function validatePassword(pw) {
  if (String(pw || '').length < 8) throw new UserError('Use at least 8 characters for your password.');
  if (String(pw).length > 72) throw new UserError('Passwords can be at most 72 characters.');
  return pw;
}

export async function getSession() {
  const { data, error } = await sb.auth.getSession();
  if (error) throw error;
  return data.session;
}

export function onAuthChange(fn) {
  return sb.auth.onAuthStateChange((event, session) => fn(event, session)).data.subscription;
}

/**
 * Creates an account. If this browser still holds an anonymous session from the previous
 * app version, that user is upgraded instead (same user id), so its data carries over.
 * Returns { needsConfirmation } — true when Supabase requires email confirmation first.
 */
export async function signUp({ email, password, name, phone }) {
  const cleanEmail = validateEmail(email);
  // The phone number (primary contact) is kept with the account and saved to the profile on first login.
  const cleanPhone = phone ? toE164(phone.code, phone.number) : null;
  validatePassword(password);
  const { data: { session } } = await sb.auth.getSession();
  if (session?.user?.is_anonymous) {
    const { error } = await sb.auth.updateUser(
      { email: cleanEmail, data: { display_name: name || null, needs_password: true, phone: cleanPhone } },
      { emailRedirectTo: APP_URL },
    );
    if (error) throw error;
    return { needsConfirmation: true, upgraded: true };
  }
  const { data, error } = await sb.auth.signUp({
    email: cleanEmail,
    password,
    options: { emailRedirectTo: APP_URL, data: { display_name: name || null, phone: cleanPhone } },
  });
  if (error) throw error;
  // With "Confirm email" on, Supabase returns a user with no session. It also returns a
  // user with no identities for an already-registered email (to avoid leaking accounts).
  if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    throw new UserError('An account with this email already exists. Try logging in.');
  }
  return { needsConfirmation: !data.session };
}

/** Logs in with a phone number (once verified) or an email, and a password. */
export async function signIn({ login, email, password }) {
  login = login ?? email; // older callers pass { email }
  if (!password) throw new UserError('Enter your password.');
  if (looksLikePhone(login)) {
    const phone = toE164('+91', login);
    const { error } = await sb.auth.signInWithPassword({ phone, password });
    if (error) {
      if (/invalid login credentials|phone.*(disabled|not.*enabled|provider)/i.test(error.message)) {
        throw new UserError('Phone number or password is incorrect. If your number isn\u2019t verified yet, log in with your email.', error);
      }
      throw error;
    }
    return;
  }
  const { error } = await sb.auth.signInWithPassword({ email: validateEmail(login), password });
  if (error) throw error;
}

export async function sendMagicLink(email) {
  const { error } = await sb.auth.signInWithOtp({
    email: validateEmail(email),
    options: { shouldCreateUser: false, emailRedirectTo: APP_URL },
  });
  // Don't reveal whether an account exists.
  if (error && !/signups not allowed|user not found/i.test(error.message)) throw error;
}

export async function sendPasswordReset(email) {
  const { error } = await sb.auth.resetPasswordForEmail(validateEmail(email), { redirectTo: APP_URL });
  if (error) throw error;
}

export async function resendConfirmation(email) {
  const { error } = await sb.auth.resend({ type: 'signup', email: validateEmail(email), options: { emailRedirectTo: APP_URL } });
  if (error) throw error;
}

export async function updatePassword(password) {
  validatePassword(password);
  const { error } = await sb.auth.updateUser({ password, data: { needs_password: false } });
  if (error) throw error;
}

export async function signInWithGoogle() {
  const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: APP_URL } });
  if (error) throw error;
}

export async function signOut(scope = 'local') {
  const { error } = await sb.auth.signOut({ scope });
  if (error && scope !== 'local') throw error;
  if (error) console.warn('[NutriLog] sign-out:', error.message);
}

/** Creates a new single-use recovery code; the plain code is returned once and never stored. */
export async function generateRecoveryCode() {
  const { code } = await callFunction('account-recovery', { action: 'generate' });
  return code;
}

export async function recoveryCodeStatus() {
  const { data, error } = await sb.rpc('recovery_code_status');
  if (error) return null;
  return data;
}

/** Resets the password using email + recovery code, then signs in. */
export async function recoverWithCode({ email, code, password }) {
  const cleanEmail = validateEmail(email);
  validatePassword(password);
  const normalized = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const body = normalized.startsWith('NUTRI') ? normalized.slice(5) : normalized;
  if (body.length !== 8) throw new UserError('Recovery codes look like NUTRI-XXXX-XXXX.');
  const formatted = `NUTRI-${body.slice(0, 4)}-${body.slice(4)}`;
  await callFunction('account-recovery', { action: 'recover', email: cleanEmail, code: formatted, password });
  await signIn({ login: cleanEmail, password });
}

export async function deleteAccount() {
  await callFunction('delete-account', { confirm: 'DELETE' });
  await sb.auth.signOut({ scope: 'local' }).catch(() => {});
}

/** User-safe message for an auth error (details are logged to the console). */
export { friendlyError as friendlyAuthError } from '../lib/utils.js';
