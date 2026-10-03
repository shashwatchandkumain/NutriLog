// Phone number — the primary contact for every account (email is secondary). Verified with a
// WhatsApp code through Supabase Auth once WhatsApp is set up (billing status → phoneVerification);
// until then the number is saved unverified. One free trial per number, so it must be real.
import { html, setHTML } from '../lib/utils.js';
import { COUNTRIES, toE164 } from '../lib/phone.js';
import { state } from '../store.js';
import { $, toast, showError, withBusy, openSheet } from '../ui/dom.js';
import { sb } from '../services/supabase.js';
import { saveProfile, loadAccount } from '../services/data.js';
import { loadBilling } from '../services/billing.js';

export const phoneVerificationOn = () => !!state.billing?.phoneVerification;
/** Whether the account still needs a phone step (missing, or unverified once verification is on). */
export const needsPhone = () => !!state.profile && (!state.profile.phone || (phoneVerificationOn() && !state.profile.phone_verified));

/** Renders the phone step into `root`. `onDone()` runs when the number is saved/verified. */
export function phoneForm(root, { onDone, required = false, initial = '' } = {}) {
  let phone = null;
  const verify = phoneVerificationOn();
  const start = initial || state.profile?.phone || state.user?.user_metadata?.phone || '';
  const startCode = COUNTRIES.find(([c]) => start.startsWith(c))?.[0] || '+91';
  const startNumber = start.startsWith(startCode) ? start.slice(startCode.length) : start;

  const askNumber = () => {
    setHTML(root, html`<form class="stack" data-phone-form novalidate>
      <div class="field"><label for="ph-number">Mobile number</label>
        <div class="phone-input">
          <select class="select" id="ph-code" aria-label="Country code">${COUNTRIES.map(([c, n]) => html`<option value="${c}" ${c === startCode ? 'selected' : ''}>${c} ${n}</option>`)}</select>
          <input class="input" id="ph-number" type="tel" inputmode="tel" autocomplete="tel-national" maxlength="16" placeholder="98765 43210" value="${startNumber}" required>
        </div>
        <span class="hint">${verify ? 'We’ll send a 6-digit code on WhatsApp.' : 'Your number is your main contact and keeps your free trial yours. We’ll verify it on WhatsApp soon.'}</span></div>
      <button class="btn btn-primary btn-block btn-lg" type="submit">${verify ? 'Send code on WhatsApp' : 'Save number'}</button>
      ${required ? '' : html`<button class="btn btn-ghost btn-block" type="button" data-skip>Cancel</button>`}
    </form>`);
    const form = root.querySelector('[data-phone-form]');
    form.querySelector('[data-skip]')?.addEventListener('click', () => onDone?.(false));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      withBusy(form.querySelector('[type=submit]'), verify ? 'Sending…' : 'Saving…', async () => {
        try {
          phone = toE164($('#ph-code', form).value, $('#ph-number', form).value);
          if (!verify) {
            await saveProfile({ phone });
            toast('Phone number saved ✓', 'success');
            onDone?.(true);
            return;
          }
          const { error } = await sb.auth.updateUser({ phone });
          if (error) throw error;
          askCode();
        } catch (err) {
          const msg = String(err?.message || '');
          if (/already|registered|exists/i.test(msg)) toast('This number is already linked to another NutriLog account.', 'error');
          else if (/whatsapp|sms|send/i.test(msg)) toast("Couldn't send the code on WhatsApp. Check the number has WhatsApp and try again.", 'error');
          else showError(err, 'phone');
        }
      });
    });
    requestAnimationFrame(() => $('#ph-number', form)?.focus());
  };

  const askCode = () => {
    setHTML(root, html`<form class="stack" data-code-form novalidate>
      <p>We sent a code on WhatsApp to <b>${phone}</b>.</p>
      <div class="field"><label for="ph-otp">6-digit code</label>
        <input class="input otp-input" id="ph-otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*" required></div>
      <button class="btn btn-primary btn-block btn-lg" type="submit">Verify</button>
      <div class="row between"><button class="link-btn small" type="button" data-change>Change number</button><button class="link-btn small" type="button" data-resend>Send again</button></div>
    </form>`);
    const form = root.querySelector('[data-code-form]');
    form.querySelector('[data-change]').addEventListener('click', askNumber);
    form.querySelector('[data-resend]').addEventListener('click', async (ev) => {
      await withBusy(ev.target, 'Sending…', async () => {
        const { error } = await sb.auth.updateUser({ phone });
        if (error) showError(error, 'resend'); else toast('New code sent on WhatsApp.');
      });
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      withBusy(form.querySelector('[type=submit]'), 'Verifying…', async () => {
        const token = $('#ph-otp', form).value.replace(/\D/g, '');
        if (token.length < 6) { toast('Enter the 6-digit code.', 'error'); return; }
        const { error } = await sb.auth.verifyOtp({ phone, token, type: 'phone_change' });
        // Supabase reports a wrong and an expired code the same way.
        if (error) { toast("That code didn't match or has expired. Check WhatsApp, or tap “Send again”.", 'error'); return; }
        await loadAccount();
        toast('Phone number verified ✓', 'success');
        onDone?.(true);
      });
    });
    requestAnimationFrame(() => $('#ph-otp', form)?.focus());
  };

  askNumber();
}

/** Full-screen step after login for accounts without a (verified) phone number. */
export async function renderPhoneGate(appEl, { onDone }) {
  if (!state.billing) await loadBilling().catch(() => {});
  setHTML(appEl, html`<main class="auth"><div class="auth-card"><div class="auth-panel">
    <h2>${state.profile?.phone && phoneVerificationOn() ? 'Verify your phone number' : 'Add your phone number'}</h2>
    <p class="sub">Your mobile number is your main contact for NutriLog — your email stays as a backup. It's never shown to anyone.</p>
    <div id="ph-step"></div>
  </div></div></main>`);
  phoneForm(appEl.querySelector('#ph-step'), { required: true, onDone });
}

/** Change the phone number from Settings. */
export function openPhoneSheet() {
  const sheet = openSheet({ title: 'Phone number' });
  phoneForm(sheet.body, { onDone: () => sheet.close() });
}
