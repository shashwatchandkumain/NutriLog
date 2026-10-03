// Supabase Auth "Send SMS" hook → sends the phone verification code on WhatsApp (Meta Cloud API).
// Supabase calls this for every phone OTP (verifying a new number, phone login codes). Secrets:
//   SEND_SMS_HOOK_SECRETS     "v1,whsec_…" from Supabase → Authentication → Hooks (verifies the caller)
//   WHATSAPP_TOKEN            Meta permanent access token (System User)
//   WHATSAPP_PHONE_NUMBER_ID  the sending number's id (Meta → WhatsApp → API setup)
//   WHATSAPP_TEMPLATE         approved "Authentication" template name (default nutrilog_otp), with a Copy-code button
//   WHATSAPP_TEMPLATE_LANG    its language code (default en)
import { env } from '../_shared/http.ts';

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const hookError = (status: number, message: string) => reply(status, { error: { http_code: status, message } });

/** Standard Webhooks signature (what Supabase Auth hooks use): base64 HMAC-SHA256 of "id.timestamp.body". */
export async function verifyHook(raw: string, headers: Headers, secrets = env('SEND_SMS_HOOK_SECRETS'), now = Date.now()): Promise<boolean> {
  const id = headers.get('webhook-id') ?? '';
  const timestamp = headers.get('webhook-timestamp') ?? '';
  const signatures = (headers.get('webhook-signature') ?? '').split(' ').map((s) => s.split(',')[1]).filter(Boolean);
  if (!id || !timestamp || !signatures.length || !secrets) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false; // replay window: 5 minutes
  for (const secret of secrets.split('|')) {
    const b64 = secret.replace(/^v1,/, '').replace(/^whsec_/, '');
    let keyBytes: Uint8Array<ArrayBuffer>;
    try { keyBytes = new Uint8Array([...atob(b64)].map((c) => c.charCodeAt(0))); } catch { continue; }
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${raw}`)));
    const expected = btoa(String.fromCharCode(...mac));
    if (signatures.some((s) => s.length === expected.length && [...s].every((ch, i) => ch === expected[i]))) return true;
  }
  return false;
}

/** The WhatsApp template message carrying the code (body parameter + Copy-code button). */
export function whatsappMessage(phone: string, otp: string, template = env('WHATSAPP_TEMPLATE') || 'nutrilog_otp', lang = env('WHATSAPP_TEMPLATE_LANG') || 'en') {
  return {
    messaging_product: 'whatsapp', recipient_type: 'individual', to: phone.replace(/\D/g, ''), type: 'template',
    template: {
      name: template, language: { code: lang },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: otp }] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: otp }] },
      ],
    },
  };
}

if (import.meta.main) {
  Deno.serve(async (req) => {
    if (req.method !== 'POST') return hookError(405, 'method not allowed');
    const raw = await req.text();
    if (!(await verifyHook(raw, req.headers))) return hookError(401, 'invalid signature');
    const token = env('WHATSAPP_TOKEN');
    const numberId = env('WHATSAPP_PHONE_NUMBER_ID');
    if (!token || !numberId) return hookError(503, 'WhatsApp verification is not set up yet.');
    let input: { user?: { phone?: string; phone_change?: string }; sms?: { otp?: string } };
    try { input = JSON.parse(raw); } catch { return hookError(400, 'bad request'); }
    // A number being added/changed is in phone_change; otherwise the account's phone.
    const phone = input.user?.phone_change || input.user?.phone || '';
    const otp = String(input.sms?.otp ?? '');
    if (!/^\d{8,15}$/.test(phone.replace(/\D/g, '')) || !/^\d{4,10}$/.test(otp)) return hookError(400, 'bad phone or code');
    const res = await fetch(`https://graph.facebook.com/v21.0/${numberId}/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(whatsappMessage(phone, otp)), signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.error('[send-otp] WhatsApp', res.status, (await res.text()).slice(0, 400));
      return hookError(502, "Couldn't send the code on WhatsApp. Check the number has WhatsApp and try again.");
    }
    return reply(200, {});
  });
}
