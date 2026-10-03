import { assert, assertEquals } from 'jsr:@std/assert@1';
import { verifyHook, whatsappMessage } from './index.ts';

const SECRET = 'v1,whsec_TWZLUTlyOEdLWXFyVHdqVVBEOElMUFpJbzJMYUxhU3c=';
const headers = (sig: string, ts = '1700000000') => new Headers({ 'webhook-id': 'msg_1', 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` });
const NOW = 1700000000 * 1000;

Deno.test('Supabase hook signature (Standard Webhooks) — vector computed with Node', async () => {
  const sig = 'oGkssAB71Qnhg31yEIzgX3DNqHzj3LWCIZTwvHhhNoQ=';
  assert(await verifyHook('{"a":1}', headers(sig), SECRET, NOW));
  assert(!(await verifyHook('{"a":2}', headers(sig), SECRET, NOW)), 'body changed');
  assert(!(await verifyHook('{"a":1}', headers(sig), SECRET, NOW + 10 * 60_000)), 'too old (replay)');
  assert(!(await verifyHook('{"a":1}', headers(sig), '', NOW)), 'no secret configured');
});

Deno.test('WhatsApp authentication template carries the code in the body and the copy-code button', () => {
  const m = whatsappMessage('+91 98765 43210', '482913', 'nutrilog_otp', 'en');
  assertEquals(m.to, '919876543210');
  assertEquals(m.template.components.map((c) => c.parameters[0].text), ['482913', '482913']);
});
