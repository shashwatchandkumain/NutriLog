// POST /functions/v1/razorpay-webhook — Razorpay → NutriLog. Set this URL in Razorpay → Settings →
// Webhooks with the secret RAZORPAY_WEBHOOK_SECRET and the subscription.* events. Every request is
// checked with the HMAC signature; each event is applied once (billing_events).
import { adminClient } from '../_shared/http.ts';
import { type RazorpaySubscription, rowFromEntity, verifyWebhook } from '../_shared/razorpay.ts';

const ok = (body: unknown = { ok: true }, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export async function handleWebhook(raw: string, signature: string, eventId: string, admin = adminClient()): Promise<Response> {
  if (!(await verifyWebhook(raw, signature))) return ok({ error: 'bad signature' }, 401);
  let payload: { event?: string; payload?: { subscription?: { entity?: RazorpaySubscription } } };
  try { payload = JSON.parse(raw); } catch { return ok({ error: 'bad json' }, 400); }
  const event = String(payload.event ?? '');
  const id = eventId || `${event}:${payload.payload?.subscription?.entity?.id}:${payload.payload?.subscription?.entity?.status}:${raw.length}`;
  const { error: dup } = await admin.from('billing_events').insert({ id, event, payload });
  if (dup) return dup.code === '23505' ? ok({ ok: true, duplicate: true }) : ok({ error: 'store failed' }, 500);

  const entity = payload.payload?.subscription?.entity;
  if (!event.startsWith('subscription.') || !entity?.id) return ok();
  const { data: row } = await admin.from('billing_subscriptions').select('id, is_trial, start_at').eq('id', entity.id).maybeSingle();
  if (!row) return ok({ ok: true, unknown: true }); // created outside NutriLog
  const update: Record<string, unknown> = rowFromEntity(entity);
  if (row.is_trial && !entity.start_at) update.start_at = row.start_at;
  if (event === 'subscription.charged' || event === 'subscription.activated') update.cancel_at_cycle_end = false;
  const { error } = await admin.from('billing_subscriptions').update(update).eq('id', entity.id);
  if (error) return ok({ error: 'update failed' }, 500); // Razorpay retries
  return ok();
}

if (import.meta.main) {
  Deno.serve(async (req) => {
    if (req.method !== 'POST') return ok({ error: 'method' }, 405);
    const raw = await req.text();
    if (raw.length > 200_000) return ok({ error: 'too large' }, 413);
    return handleWebhook(raw, req.headers.get('x-razorpay-signature') ?? '', req.headers.get('x-razorpay-event-id') ?? '');
  });
}
