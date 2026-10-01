// Signed-out screens: welcome, create account, log in, forgot password, recovery code,
// "check your email", and set-new-password (after a reset link).
import { html, setHTML } from '../lib/utils.js';
import { $, toast, showError, withBusy, formData } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { CONFIG } from '../config.js';
import * as auth from '../services/auth.js';
import { navigate } from '../router.js';

const logo = html`<span class="logo lg"><span class="logo-mark" aria-hidden="true">🥗</span><span>Nutri<strong>Log</strong></span></span>`;

let pendingEmail = '';
let checkEmailKind = 'confirm';

function shell(root, inner, { hero = true } = {}) {
  setHTML(root, html`
    <main class="auth">
      <div class="auth-card">
        ${hero ? html`<div class="auth-hero">${logo}<p>Your personal nutrition companion</p></div>` : ''}
        ${inner}
      </div>
    </main>`);
}

const passwordField = (id, label, autocomplete) => html`
  <div class="field">
    <label for="${id}">${label}</label>
    <div class="input-group">
      <input class="input" id="${id}" name="password" type="password" autocomplete="${autocomplete}" minlength="8" maxlength="72" required>
      <button type="button" class="input-suffix" data-toggle-pw="${id}" aria-label="Show password">Show</button>
    </div>
  </div>`;

function bindPasswordToggles(root) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-toggle-pw]');
    if (!b) return;
    const input = document.getElementById(b.dataset.togglePw);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    b.textContent = show ? 'Hide' : 'Show';
    b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });
}

const googleButton = () => (CONFIG.ENABLE_GOOGLE_AUTH ? html`
  <div class="divider">or</div>
  <button type="button" class="btn btn-secondary btn-block" data-google>${icon('google')} Continue with Google</button>` : '');

function bindGoogle(root) {
  root.querySelector('[data-google]')?.addEventListener('click', (e) => withBusy(e.currentTarget, 'Opening Google…', async () => {
    try { await auth.signInWithGoogle(); } catch (err) { showError(err, 'google sign-in'); }
  }));
}

/** Remembers the email typed on one screen so the next auth screen can prefill it. */
function trackEmail(root) {
  root.querySelector('input[type=email]')?.addEventListener('input', (e) => { pendingEmail = e.target.value.trim(); });
}

function formError(form, message) {
  let box = form.querySelector('.form-error');
  if (!message) { box?.remove(); return; }
  if (!box) { box = document.createElement('div'); box.className = 'form-error'; box.setAttribute('role', 'alert'); form.prepend(box); }
  box.textContent = message;
}

// ── Screens ───────────────────────────────────────────────────────────────
export function renderWelcome(root, { legacyAnonymous = false } = {}) {
  shell(root, html`
    ${legacyAnonymous ? html`<div class="banner"><span aria-hidden="true">💾</span><div class="grow"><b>Welcome back to NutriLog</b>This device has data from the previous version. Create an account with your email to keep it and sync it across devices.</div></div>` : ''}
    <div class="auth-panel">
      <div class="features">
        <div class="feature"><span class="feature-icon" aria-hidden="true">✨</span><div><b>Describe it, snap it, done</b>AI (Gemini or Claude) works out any meal — roti, dal, biryani — and you check it before saving.</div></div>
        <div class="feature"><span class="feature-icon" aria-hidden="true">⚖️</span><div><b>Smart-scale weigh-ins</b>Measure over Bluetooth: weight, heart rate and body composition in one tap.</div></div>
        <div class="feature"><span class="feature-icon" aria-hidden="true">🎯</span><div><b>Hit your target by your date</b>Calories planned from your weight, activity and goal date — synced to every device.</div></div>
      </div>
      <div class="stack" style="margin-top:22px">
        <a class="btn btn-primary btn-lg btn-block" href="#/signup">Create account</a>
        <a class="btn btn-secondary btn-lg btn-block" href="#/login">Log in</a>
      </div>
    </div>
    <p class="auth-foot tiny">Your data is stored in your personal account and protected by Supabase Row Level Security.</p>`);
}

export function renderSignup(root, { legacyAnonymous = false } = {}) {
  shell(root, html`
    <div class="auth-panel">
      <h2>Create your account</h2>
      <p class="sub">${legacyAnonymous ? 'Your existing data on this device will be kept.' : 'Takes less than a minute. No credit card, no API keys.'}</p>
      <form class="stack" id="signup-form" novalidate>
        <div class="field"><label for="su-name">Name <span class="faint">(optional)</span></label><input class="input" id="su-name" name="name" autocomplete="given-name" maxlength="80"></div>
        <div class="field"><label for="su-email">Email</label><input class="input" id="su-email" name="email" type="email" autocomplete="email" inputmode="email" required></div>
        ${passwordField('su-password', 'Password', 'new-password')}
        <span class="hint" style="margin-top:-6px">At least 8 characters.</span>
        <button class="btn btn-primary btn-block btn-lg" type="submit">Create account</button>
      </form>
      ${legacyAnonymous ? '' : googleButton()}
    </div>
    <div class="auth-foot"><span>Already have an account? <a href="#/login">Log in</a></span><a href="#/welcome">Back</a></div>`);
  const form = $('#signup-form', root);
  trackEmail(root);
  bindPasswordToggles(root);
  bindGoogle(root);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    withBusy(btn, 'Creating account…', async () => {
      formError(form, '');
      const { name, email, password } = formData(form);
      try {
        const res = await auth.signUp({ email, password, name });
        pendingEmail = email;
        if (res.needsConfirmation) {
          checkEmailKind = res.upgraded ? 'upgrade' : 'confirm';
          navigate('check-email');
        }
        // Otherwise onAuthStateChange(SIGNED_IN) takes the user to onboarding.
      } catch (err) {
        formError(form, err.userMessage || auth.friendlyAuthError(err));
      }
    });
  });
}

export function renderLogin(root) {
  shell(root, html`
    <div class="auth-panel">
      <h2>Welcome back</h2>
      <p class="sub">Log in to see your meals and progress on this device.</p>
      <form class="stack" id="login-form" novalidate>
        <div class="field"><label for="li-email">Email</label><input class="input" id="li-email" name="email" type="email" autocomplete="email" inputmode="email" required value="${pendingEmail}"></div>
        ${passwordField('li-password', 'Password', 'current-password')}
        <div class="row between"><a href="#/forgot" class="small">Forgot password?</a><button type="button" class="link-btn small" data-magic>Email me a sign-in link</button></div>
        <button class="btn btn-primary btn-block btn-lg" type="submit">Log in</button>
      </form>
      ${googleButton()}
    </div>
    <div class="auth-foot"><span>New to NutriLog? <a href="#/signup">Create an account</a></span><a href="#/welcome">Back</a></div>`);
  const form = $('#login-form', root);
  trackEmail(root);
  bindPasswordToggles(root);
  bindGoogle(root);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    withBusy(form.querySelector('[type=submit]'), 'Logging in…', async () => {
      formError(form, '');
      const { email, password } = formData(form);
      pendingEmail = email;
      try { await auth.signIn({ email, password }); } catch (err) { formError(form, err.userMessage || auth.friendlyAuthError(err)); }
    });
  });
  root.querySelector('[data-magic]').addEventListener('click', (e) => withBusy(e.currentTarget, 'Sending…', async () => {
    formError(form, '');
    const email = form.email.value.trim();
    try {
      await auth.sendMagicLink(email);
      pendingEmail = email; checkEmailKind = 'magic';
      navigate('check-email');
    } catch (err) { formError(form, err.userMessage || auth.friendlyAuthError(err)); }
  }));
}

export function renderForgot(root) {
  shell(root, html`
    <div class="auth-panel">
      <h2>Reset your password</h2>
      <p class="sub">We'll email you a link to choose a new password.</p>
      <form class="stack" id="forgot-form" novalidate>
        <div class="field"><label for="fp-email">Email</label><input class="input" id="fp-email" name="email" type="email" autocomplete="email" inputmode="email" required value="${pendingEmail}"></div>
        <button class="btn btn-primary btn-block btn-lg" type="submit">Send reset link</button>
      </form>
      <div class="divider">or</div>
      <a class="btn btn-secondary btn-block" href="#/recover">Use a recovery code</a>
    </div>
    <div class="auth-foot"><a href="#/login">Back to log in</a></div>`);
  const form = $('#forgot-form', root);
  trackEmail(root);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    withBusy(form.querySelector('[type=submit]'), 'Sending…', async () => {
      formError(form, '');
      const { email } = formData(form);
      try {
        await auth.sendPasswordReset(email);
        pendingEmail = email; checkEmailKind = 'reset';
        navigate('check-email');
      } catch (err) { formError(form, err.userMessage || auth.friendlyAuthError(err)); }
    });
  });
}

export function renderRecoverCode(root) {
  shell(root, html`
    <div class="auth-panel">
      <h2>Recover with a code</h2>
      <p class="sub">Enter the recovery code you saved when you created your account (NUTRI-XXXX-XXXX). Each code works once.</p>
      <form class="stack" id="rc-form" novalidate>
        <div class="field"><label for="rc-email">Email</label><input class="input" id="rc-email" name="email" type="email" autocomplete="email" inputmode="email" required value="${pendingEmail}"></div>
        <div class="field"><label for="rc-code">Recovery code</label><input class="input" id="rc-code" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="NUTRI-XXXX-XXXX" required></div>
        ${passwordField('rc-password', 'New password', 'new-password')}
        <button class="btn btn-primary btn-block btn-lg" type="submit">Reset password & log in</button>
      </form>
    </div>
    <div class="auth-foot"><a href="#/forgot">Back</a></div>`);
  const form = $('#rc-form', root);
  trackEmail(root);
  bindPasswordToggles(root);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    withBusy(form.querySelector('[type=submit]'), 'Checking code…', async () => {
      formError(form, '');
      const { email, code, password } = formData(form);
      try {
        await auth.recoverWithCode({ email, code, password });
        toast('Password reset. You can create a new recovery code in Settings.', 'success');
      } catch (err) { formError(form, err.userMessage || auth.friendlyAuthError(err)); }
    });
  });
}

export function renderCheckEmail(root) {
  const copy = {
    confirm: ['Confirm your email', `We sent a confirmation link to ${pendingEmail || 'your email'}. Open it on this or any device to finish creating your account.`],
    upgrade: ['Confirm your email', `We sent a link to ${pendingEmail || 'your email'}. After confirming, you'll set a password and your existing data stays with your new account.`],
    magic: ['Check your email', `If an account exists for ${pendingEmail || 'that address'}, a sign-in link is on its way.`],
    reset: ['Check your email', `If an account exists for ${pendingEmail || 'that address'}, you'll get a link to choose a new password.`],
  }[checkEmailKind] || ['Check your email', ''];
  shell(root, html`
    <div class="auth-panel center">
      <div class="empty-icon" aria-hidden="true">✉️</div>
      <h2>${copy[0]}</h2>
      <p class="sub" style="margin-top:6px">${copy[1]}</p>
      <p class="small muted">Can't find it? Check your spam folder.</p>
      ${checkEmailKind === 'confirm' && pendingEmail ? html`<button type="button" class="btn btn-secondary btn-block" style="margin-top:14px" data-resend>Resend email</button>` : ''}
    </div>
    <div class="auth-foot"><a href="#/login">Back to log in</a></div>`);
  root.querySelector('[data-resend]')?.addEventListener('click', (e) => withBusy(e.currentTarget, 'Sending…', async () => {
    try { await auth.resendConfirmation(pendingEmail); toast('Email sent again.', 'success'); } catch (err) { showError(err, 'resend'); }
  }));
}

/** Used after a password-reset link, and to set a first password after an account upgrade. */
export function renderSetPassword(root, { onDone, firstTime = false } = {}) {
  shell(root, html`
    <div class="auth-panel">
      <h2>${firstTime ? 'Create a password' : 'Choose a new password'}</h2>
      <p class="sub">${firstTime ? 'Use it to log in on your other devices.' : "You're signed in through the reset link. Set a new password to finish."}</p>
      <form class="stack" id="np-form" novalidate>
        ${passwordField('np-password', 'New password', 'new-password')}
        <div class="field"><label for="np-confirm">Confirm password</label><input class="input" id="np-confirm" name="confirm" type="password" autocomplete="new-password" required></div>
        <button class="btn btn-primary btn-block btn-lg" type="submit">Save password</button>
      </form>
    </div>`);
  const form = $('#np-form', root);
  bindPasswordToggles(root);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    withBusy(form.querySelector('[type=submit]'), 'Saving…', async () => {
      formError(form, '');
      const { password, confirm } = formData(form);
      if (password !== confirm) { formError(form, "The passwords don't match."); return; }
      try {
        await auth.updatePassword(password);
        toast('Password saved.', 'success');
        onDone?.();
      } catch (err) { formError(form, err.userMessage || auth.friendlyAuthError(err)); }
    });
  });
}
