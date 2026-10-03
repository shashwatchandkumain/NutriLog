// POST /functions/v1/delete-account   Body: { confirm: 'DELETE' }
// Permanently deletes the signed-in user. Every table references auth.users with
// ON DELETE CASCADE, so all meals, weights, goals and settings are removed with the account.
import { adminClient, HttpError, json, readJson, requireUser, serve } from '../_shared/http.ts';
import { razorpay, razorpayReady } from '../_shared/razorpay.ts';

serve(async (req) => {
  const { user } = await requireUser(req);
  const body = await readJson<{ confirm?: string }>(req, 1_000);
  if (body.confirm !== 'DELETE') throw new HttpError(400, 'not_confirmed', 'Type DELETE to confirm.');

  const admin = adminClient();
  // Stop any running subscription first, so nobody is charged for a deleted account.
  const { data: subs } = await admin.from('billing_subscriptions').select('id').eq('user_id', user.id)
    .in('status', ['authenticated', 'active', 'pending', 'halted', 'paused']);
  for (const s of razorpayReady() ? subs ?? [] : []) {
    try {
      await razorpay('POST', `/subscriptions/${s.id}/cancel`, { cancel_at_cycle_end: 0 });
    } catch (e) {
      throw new HttpError(502, 'cancel_failed', "Couldn't cancel your subscription. Please try again, or cancel it in Settings first.", e);
    }
  }
  // Rows from the previous app version are keyed by a text id and have no foreign key.
  for (const table of ['legacy_meals', 'legacy_activities', 'legacy_weight_logs', 'legacy_user_settings']) {
    const { error } = await admin.from(table).delete().eq('user_id', user.id);
    if (error && !/does not exist|schema cache/i.test(error.message)) console.error(`[delete-account] ${table}:`, error.message);
  }
  const { error } = await admin.auth.admin.deleteUser(user.id);
  if (error) throw new HttpError(500, 'delete_failed', 'Something went wrong. Please try again.', error);
  return json(req, { ok: true });
});
