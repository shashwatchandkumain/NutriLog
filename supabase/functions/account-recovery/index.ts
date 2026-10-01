// POST /functions/v1/account-recovery
//   { action: 'generate' }                        (signed in) → { code } — shown to the user once
//   { action: 'recover', email, code, password }  (signed out) → { ok: true }
//
// Recovery codes are stored only as bcrypt hashes (see public.set_recovery_code). A code is
// single-use. Attempts are rate-limited per email address and globally, and failures return
// the same message whether or not the email exists.
import { adminClient, HttpError, json, readJson, requireUser, serve } from '../_shared/http.ts';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, L, O, 0, 1
const CODE_RE = /^NUTRI-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const MAX_PER_EMAIL_PER_HOUR = 5;
const MAX_GLOBAL_PER_MINUTE = 30;

function newCode(): string {
  // Rejection sampling keeps every character equally likely.
  const limit = 256 - (256 % ALPHABET.length);
  let chars = '';
  while (chars.length < 8) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < limit && chars.length < 8) chars += ALPHABET[b % ALPHABET.length];
    }
  }
  return `NUTRI-${chars.slice(0, 4)}-${chars.slice(4)}`;
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

serve(async (req) => {
  const body = await readJson<{ action?: string; email?: string; code?: string; password?: string }>(req, 10_000);
  const admin = adminClient();

  if (body.action === 'generate') {
    const { user } = await requireUser(req);
    const code = newCode();
    const { error } = await admin.rpc('set_recovery_code', { p_user_id: user.id, p_code: code });
    if (error) throw new HttpError(500, 'store_failed', 'Something went wrong. Please try again.', error);
    return json(req, { code });
  }

  if (body.action === 'recover') {
    const email = String(body.email ?? '').trim().toLowerCase();
    const code = String(body.code ?? '').trim().toUpperCase().replace(/\s+/g, '');
    const password = String(body.password ?? '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) throw new HttpError(400, 'bad_email', 'Enter a valid email address.');
    if (!CODE_RE.test(code)) throw new HttpError(400, 'bad_code', 'Recovery codes look like NUTRI-XXXX-XXXX.');
    if (password.length < 8 || password.length > 72) throw new HttpError(400, 'weak_password', 'Choose a password with at least 8 characters.');

    const emailHash = await sha256Hex(email);
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const minuteAgo = new Date(Date.now() - 60_000).toISOString();
    const [{ count: perEmail }, { count: global }] = await Promise.all([
      admin.from('recovery_attempts').select('id', { count: 'exact', head: true }).eq('email_hash', emailHash).gte('attempted_at', hourAgo),
      admin.from('recovery_attempts').select('id', { count: 'exact', head: true }).gte('attempted_at', minuteAgo),
    ]);
    if ((perEmail ?? 0) >= MAX_PER_EMAIL_PER_HOUR || (global ?? 0) >= MAX_GLOBAL_PER_MINUTE) {
      throw new HttpError(429, 'rate_limited', 'Too many attempts. Please wait an hour and try again.');
    }

    const { data: userId, error } = await admin.rpc('verify_recovery_code', { p_email: email, p_code: code });
    await admin.from('recovery_attempts').insert({ email_hash: emailHash, success: !!userId && !error });
    if (error) throw new HttpError(500, 'verify_failed', 'Something went wrong. Please try again.', error);
    if (!userId) throw new HttpError(400, 'invalid_code', "That email and recovery code don't match.");

    const { error: updErr } = await admin.auth.admin.updateUserById(userId, { password });
    if (updErr) {
      // Put the (single-use) code back so the user can try again with a different password.
      await admin.rpc('set_recovery_code', { p_user_id: userId, p_code: code });
      throw new HttpError(400, 'password_rejected', 'That password was rejected. Please choose a stronger one.', updErr);
    }
    return json(req, { ok: true });
  }

  throw new HttpError(400, 'bad_action', 'Invalid request.');
});
