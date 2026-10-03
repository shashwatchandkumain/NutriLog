import { assertEquals } from 'jsr:@std/assert@1';
import { hmacHex } from '../_shared/razorpay.ts';

Deno.env.set('RAZORPAY_WEBHOOK_SECRET', 'wh_test_secret');
const { handleWebhook } = await import('./index.ts');

/** A tiny stand-in for the Supabase admin client: billing_events + billing_subscriptions. */
function fakeAdmin() {
  const events = new Set<string>();
  const subs = new Map<string, Record<string, unknown>>([['sub_T', { id: 'sub_T', is_trial: true, start_at: '2026-10-10T00:00:00.000Z', status: 'created' }]]);
  const api = {
    subs,
    from(table: string) {
      return {
        insert: async (row: { id: string }) => {
          if (events.has(row.id)) return { error: { code: '23505' } };
          events.add(row.id); return { error: null };
        },
        select: () => ({ eq: (_k: string, v: string) => ({ maybeSingle: async () => ({ data: table === 'billing_subscriptions' ? subs.get(v) ?? null : null }) }) }),
        update: (u: Record<string, unknown>) => ({ eq: async (_k: string, v: string) => { subs.set(v, { ...subs.get(v), ...u }); return { error: null }; } }),
      };
    },
  };
  return api;
}

const body = (event: string, entity: Record<string, unknown>) => JSON.stringify({ event, payload: { subscription: { entity } } });

Deno.test('webhook: signed events update the subscription once; unsigned ones are refused', async () => {
  const admin = fakeAdmin();
  const raw = body('subscription.authenticated', { id: 'sub_T', plan_id: 'plan_x', status: 'authenticated', start_at: null });
  const sig = await hmacHex('wh_test_secret', raw);
  // deno-lint-ignore no-explicit-any
  const a = admin as any;
  assertEquals((await handleWebhook(raw, 'bad', 'evt_1', a)).status, 401);
  assertEquals((await handleWebhook(raw, sig, 'evt_1', a)).status, 200);
  assertEquals([admin.subs.get('sub_T')!.status, admin.subs.get('sub_T')!.start_at], ['authenticated', '2026-10-10T00:00:00.000Z'], 'trial start kept');
  admin.subs.get('sub_T')!.status = 'tampered';
  assertEquals(await (await handleWebhook(raw, sig, 'evt_1', a)).json(), { ok: true, duplicate: true });
  assertEquals(admin.subs.get('sub_T')!.status, 'tampered', 'a repeated event is not applied twice');
  const charged = body('subscription.charged', { id: 'sub_T', plan_id: 'plan_x', status: 'active', current_start: 1791504000, current_end: 1794182400 });
  await handleWebhook(charged, await hmacHex('wh_test_secret', charged), 'evt_2', a);
  assertEquals([admin.subs.get('sub_T')!.status, admin.subs.get('sub_T')!.current_end], ['active', new Date(1794182400 * 1000).toISOString()]);
});
