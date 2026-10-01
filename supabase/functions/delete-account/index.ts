// POST /functions/v1/delete-account   Body: { confirm: 'DELETE' }
// Permanently deletes the signed-in user. Every table references auth.users with
// ON DELETE CASCADE, so all meals, weights, goals and settings are removed with the account.
import { adminClient, HttpError, json, readJson, requireUser, serve } from '../_shared/http.ts';

serve(async (req) => {
  const { user } = await requireUser(req);
  const body = await readJson<{ confirm?: string }>(req, 1_000);
  if (body.confirm !== 'DELETE') throw new HttpError(400, 'not_confirmed', 'Type DELETE to confirm.');

  const admin = adminClient();
  // Rows from the previous app version are keyed by a text id and have no foreign key.
  for (const table of ['legacy_meals', 'legacy_activities', 'legacy_weight_logs', 'legacy_user_settings']) {
    const { error } = await admin.from(table).delete().eq('user_id', user.id);
    if (error && !/does not exist|schema cache/i.test(error.message)) console.error(`[delete-account] ${table}:`, error.message);
  }
  const { error } = await admin.auth.admin.deleteUser(user.id);
  if (error) throw new HttpError(500, 'delete_failed', 'Something went wrong. Please try again.', error);
  return json(req, { ok: true });
});
