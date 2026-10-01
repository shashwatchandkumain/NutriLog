// NutriLog entry point: auth-gated routing, app shell, sync & realtime wiring.
//
//   open site → no session      → welcome / log in / create account
//             → session, new     → profile setup (onboarding)
//             → session          → dashboard (restored instantly from cache, then synced)
import { html, setHTML, GENERIC_ERROR, debounce, today } from './lib/utils.js';
import { state, on, emit } from './store.js';
import { configProblem } from './services/supabase.js';
import * as auth from './services/auth.js';
import * as data from './services/data.js';
import { startReminders, stopReminders } from './services/reminders.js';
import { currentRoute, navigate, clearAuthFragment } from './router.js';
import { toast, closeAllSheets, $ } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { applyTheme, getThemePref, nextTheme } from './ui/theme.js';
import { computeStreak } from './lib/stats.js';
import { renderWelcome, renderSignup, renderLogin, renderForgot, renderRecoverCode, renderCheckEmail, renderSetPassword } from './views/auth.js';
import { renderOnboarding } from './views/onboarding.js';
import { mountDashboard } from './views/dashboard.js';
import { mountCalories } from './views/calories.js';
import { mountProgress } from './views/progress.js';
import { mountSettings } from './views/settings.js';
import { openFoodLogger } from './views/food-logger.js';
import { openCoach } from './views/chat.js';
import { loadFoods } from './services/foods.js';

const appEl = document.getElementById('app');
const AUTH_ROUTES = new Set(['welcome', 'signup', 'login', 'forgot', 'recover', 'check-email']);
const APP_ROUTES = { dashboard: mountDashboard, calories: mountCalories, progress: mountProgress, settings: mountSettings };
const initialHash = window.__nutrilogInitialHash || '';

let shellMounted = false;
let unmountView = null;
let viewRoute = null;
let bootstrappedFor = null;
let accountError = null;

// ── Startup ───────────────────────────────────────────────────────────────
function hideBoot() {
  const b = document.getElementById('boot');
  if (b) { b.classList.add('done'); setTimeout(() => b.remove(), 400); }
}
const setBootText = (t) => { const el = document.getElementById('boot-text'); if (el) el.textContent = t; };

/** The previous version kept API keys and settings in localStorage. Remove them. */
function purgeLegacyStorage() {
  try {
    for (const k of ['geminiKey', 'claudeKey', 'supaUrl', 'supaKey', 'aiProvider', 'secureMode', 'goals', 'bodyStats', 'dietMode']) localStorage.removeItem(k);
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (/^(chat_|water_|lastStreakCel_)/.test(k)) localStorage.removeItem(k);
    }
    const legacyId = localStorage.getItem('userId');
    if (legacyId) { localStorage.setItem('nutrilog.legacyDeviceId', legacyId); localStorage.removeItem('userId'); }
  } catch { /* storage unavailable */ }
}

function renderConfigProblem() {
  const secret = configProblem === 'secret-key';
  setHTML(appEl, html`<main class="auth"><div class="auth-card"><div class="auth-panel">
    <span class="logo"><span class="logo-mark" aria-hidden="true">🥗</span><span>Nutri<strong>Log</strong></span></span>
    <h2 style="margin-top:16px">${secret ? 'Unsafe configuration blocked' : 'NutriLog is almost ready'}</h2>
    <p class="sub" style="margin-top:6px">${secret
      ? 'This site was configured with a secret Supabase key, which must never be public. The site owner needs to replace it with the anon/publishable key and rotate the secret key.'
      : "This copy of NutriLog hasn't been connected to its database yet. If you're the site owner, add your Supabase project URL and anon key to js/config.js (see README → Supabase setup)."}</p>
  </div></div></main>`);
}

async function boot() {
  purgeLegacyStorage();
  applyTheme(getThemePref());
  registerServiceWorker();
  if (configProblem) { renderConfigProblem(); hideBoot(); return; }

  // Links from auth emails land here with tokens or an error in the fragment.
  const authError = /error_description=([^&]+)/.exec(initialHash);
  if (/type=recovery/.test(initialHash)) state.passwordRecovery = true;

  // Defer work out of the callback: awaiting Supabase calls inside it can deadlock supabase-js.
  auth.onAuthChange((event, session) => { setTimeout(() => handleAuthEvent(event, session), 0); });
  let session = null;
  try {
    setBootText('Loading…');
    session = await auth.getSession();
  } catch (e) {
    console.error('[NutriLog] session restore failed', e);
  }
  clearAuthFragment();
  if (authError) {
    const msg = decodeURIComponent(authError[1].replace(/\+/g, ' '));
    toast(/expired|invalid/i.test(msg) ? 'That link has expired or was already used. Please request a new one.' : GENERIC_ERROR, 'error');
    console.warn('[NutriLog] auth link error:', msg);
  }
  await setSession(session);
  window.addEventListener('hashchange', render);
  render();
  hideBoot();
}

// ── Auth state ────────────────────────────────────────────────────────────
const isRealUser = (s) => !!s?.user && !s.user.is_anonymous;

async function setSession(session) {
  state.session = session;
  state.user = session?.user || null;
  if (isRealUser(session)) {
    if (bootstrappedFor !== session.user.id) await bootstrapUser(session.user);
  } else if (bootstrappedFor) {
    teardownUser();
  }
}

async function handleAuthEvent(event, session) {
  if (event === 'INITIAL_SESSION') return; // handled by boot()
  if (event === 'PASSWORD_RECOVERY') { state.passwordRecovery = true; }
  if (event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
    state.session = session; state.user = session?.user || null;
    if (event === 'USER_UPDATED') render();
    return;
  }
  if (event === 'SIGNED_OUT') { teardownUser(); state.session = null; state.user = null; closeAllSheets(); navigate('welcome', { replace: true }); render(); return; }
  if (event === 'SIGNED_IN') {
    const firstSignIn = bootstrappedFor !== session?.user?.id;
    await setSession(session);
    clearAuthFragment();
    if (firstSignIn && isRealUser(session)) {
      if (AUTH_ROUTES.has(currentRoute()) || !currentRoute()) navigate('dashboard', { replace: true });
      render();
    }
  }
}

async function bootstrapUser(user) {
  bootstrappedFor = user.id;
  accountError = null;
  data.startDataSession(user.id);
  if (!state.profile) setBootText('Loading your dashboard…');
  try {
    await data.loadAccount();
    if (state.prefs?.theme && state.prefs.theme !== getThemePref()) applyTheme(state.prefs.theme);
  } catch (e) {
    console.error('[NutriLog] account load failed', e);
    if (!state.profile) accountError = e;
  }
  data.fetchWeights().catch((e) => console.warn('[NutriLog] weights', e.message));
  data.fetchLoggedDates().then(() => updateShellStatus()).catch((e) => console.warn('[NutriLog] streak', e.message));
  data.importLegacyData().then((r) => {
    if (r && (r.meal_items || r.weights || r.activities)) {
      toast(`Imported your data from the previous version (${r.meal_items} food entries, ${r.weights} weigh-ins).`, 'success', { duration: 7000 });
      emit('data-changed'); emit('remote-day', state.date);
      data.fetchWeights().catch(() => {});
      data.fetchLoggedDates().catch(() => {});
    }
  });
  data.subscribeRealtime(onRemoteChange);
  // Warm the food database so search works instantly (and offline) later.
  (window.requestIdleCallback || setTimeout)(() => loadFoods().catch(() => {}));
  startReminders(() => toast("Reminder: you haven't logged anything today.", 'info', { action: 'Add food', onAction: () => openFoodLogger() }));
}

function teardownUser() {
  data.unsubscribeRealtime();
  stopReminders();
  data.endDataSession();
  bootstrappedFor = null;
  Object.assign(state, { profile: null, prefs: null, goals: null, day: null, weights: [], loggedDates: [], date: today(), passwordRecovery: false });
  unmountApp();
}

export function signedOut() {
  teardownUser();
  state.session = null; state.user = null;
  closeAllSheets();
  navigate('welcome', { replace: true });
}

// ── Cross-device sync ─────────────────────────────────────────────────────
const refreshAccount = debounce(() => data.loadAccount().catch(() => {}), 500);
const refreshWeights = debounce(() => data.fetchWeights().catch(() => {}), 500);
const refreshDates = debounce(() => data.fetchLoggedDates().then(updateShellStatus).catch(() => {}), 800);
const refreshDay = debounce(() => { emit('remote-day', state.date); emit('data-changed'); }, 400);

function onRemoteChange(table) {
  if (table === 'meal_items' || table === 'activities' || table === 'water_logs') { refreshDay(); if (table === 'meal_items') refreshDates(); }
  else if (table === 'weight_history') refreshWeights();
  else refreshAccount();
}

let lastFocusRefresh = Date.now();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !bootstrappedFor) return;
  data.flush();
  if (Date.now() - lastFocusRefresh > 30_000) {
    lastFocusRefresh = Date.now();
    refreshDay(); refreshAccount(); refreshWeights(); refreshDates();
  }
});
window.addEventListener('online', () => { state.online = true; emit('sync'); data.flush(); if (bootstrappedFor) refreshDay(); });
window.addEventListener('offline', () => { state.online = false; emit('sync'); });
on('toast', ({ message, type }) => toast(message, type));

// ── Rendering ─────────────────────────────────────────────────────────────
function unmountApp() {
  unmountView?.(); unmountView = null; viewRoute = null;
  shellMounted = false;
}

function render() {
  const route = currentRoute();
  const signedIn = isRealUser(state.session);

  if (!signedIn) {
    unmountApp();
    const legacyAnonymous = !!state.session?.user?.is_anonymous;
    const r = AUTH_ROUTES.has(route) ? route : 'welcome';
    if (route !== r) history.replaceState(null, '', `#/${r}`);
    const renderers = { welcome: renderWelcome, signup: renderSignup, login: renderLogin, forgot: renderForgot, recover: renderRecoverCode, 'check-email': renderCheckEmail };
    renderers[r](appEl, { legacyAnonymous });
    appEl.querySelector('h2, h1, input')?.focus?.({ preventScroll: true });
    window.scrollTo({ top: 0 });
    return;
  }

  if (state.passwordRecovery || route === 'set-password') {
    unmountApp();
    renderSetPassword(appEl, {
      firstTime: !state.passwordRecovery && !!state.user?.user_metadata?.needs_password,
      onDone: () => { state.passwordRecovery = false; navigate('dashboard', { replace: true }); },
    });
    return;
  }

  if (!state.profile) {
    unmountApp();
    if (accountError) {
      setHTML(appEl, html`<main class="auth"><div class="auth-card"><div class="auth-panel center">
        <div class="empty-icon" aria-hidden="true">⚠️</div><h2>Couldn't load your account</h2>
        <p class="sub" style="margin-top:6px">${navigator.onLine ? GENERIC_ERROR : "You're offline. Connect to the internet and try again."}</p>
        <div class="stack"><button type="button" class="btn btn-primary btn-block" id="retry-account">Try again</button>
        <button type="button" class="btn btn-ghost btn-block" id="logout-account">Log out</button></div></div></div></main>`);
      $('#retry-account').addEventListener('click', async () => { bootstrappedFor = null; await setSession(state.session); render(); });
      $('#logout-account').addEventListener('click', async () => { await auth.signOut('local'); signedOut(); });
    } else {
      setHTML(appEl, html`<main class="auth"><div class="boot-inner"><div class="spinner"></div><span>Loading your dashboard…</span></div></main>`);
    }
    return;
  }

  if (!state.profile.onboarding_completed) {
    unmountApp();
    renderOnboarding(appEl, { onDone: () => { navigate('dashboard', { replace: true }); render(); } });
    return;
  }

  const target = APP_ROUTES[route] ? route : 'dashboard';
  if (route !== target) history.replaceState(null, '', `#/${target}`);
  mountShell();
  if (viewRoute === target) return;
  unmountView?.();
  const main = $('#view');
  const container = document.createElement('div');
  main.replaceChildren(container);
  viewRoute = target;
  unmountView = APP_ROUTES[target](container, { onSignedOut: signedOut });
  for (const a of document.querySelectorAll('[data-nav]')) {
    if (a.dataset.nav === target) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  document.title = `${{ dashboard: 'Dashboard', calories: 'Calories', progress: 'Progress', settings: 'Settings' }[target]} · NutriLog`;
  window.scrollTo({ top: 0 });
}

const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: 'home' },
  { id: 'calories', label: 'Calories', icon: 'flame' },
  { id: 'progress', label: 'Progress', icon: 'chart' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

function mountShell() {
  if (shellMounted) return;
  shellMounted = true;
  setHTML(appEl, html`
    <a class="sr-only" href="#view">Skip to content</a>
    <header class="topbar">
      <a class="logo" href="#/dashboard" aria-label="NutriLog home"><span class="logo-mark" aria-hidden="true">🥗</span><span>Nutri<strong>Log</strong></span></a>
      <nav class="topnav" aria-label="Main">${NAV.map((n) => html`<a href="#/${n.id}" data-nav="${n.id}">${n.label}</a>`)}</nav>
      <div class="topbar-right">
        <span id="sync-pill" hidden></span>
        <span class="streak-pill" id="streak-pill" title="Logging streak" hidden></span>
        <button type="button" class="btn btn-secondary btn-sm topbar-chat" id="chat-top" aria-label="Open Nutri AI coach">${icon('chat', 16)} Nutri AI</button>
        <button type="button" class="icon-btn" id="theme-toggle" aria-label="Change theme"></button>
      </div>
    </header>
    <main class="main" id="view" tabindex="-1"></main>
    <nav class="bottomnav" aria-label="Main">${NAV.map((n) => html`<a href="#/${n.id}" data-nav="${n.id}">${icon(n.icon)}<span>${n.label}</span></a>`)}</nav>
    <button type="button" class="chat-fab" id="chat-fab" aria-label="Open Nutri AI coach">${icon('chat')}<span>Nutri AI</span></button>
    <button type="button" class="fab" id="add-fab" aria-label="Add food">${icon('plus')}</button>`);
  $('#add-fab').addEventListener('click', () => openFoodLogger());
  $('#chat-fab').addEventListener('click', () => openCoach());
  $('#chat-top').addEventListener('click', () => openCoach());
  $('#theme-toggle').addEventListener('click', () => {
    const next = nextTheme(getThemePref());
    applyTheme(next);
    toast(`Theme: ${next[0].toUpperCase()}${next.slice(1)}`);
    data.savePrefs({ theme: next }).catch((e) => console.warn('[NutriLog] theme sync', e.message));
  });
  updateShellStatus();
}

function updateShellStatus() {
  if (!shellMounted) return;
  const pill = $('#sync-pill');
  if (pill) {
    let content = null, cls = 'sync-pill';
    if (!state.online) { cls += ' offline'; content = html`${icon('cloudOff', 14)} Offline${state.pending ? ` · ${state.pending} to sync` : ''}`; }
    else if (state.syncing || state.pending) content = html`<span class="spinner" aria-hidden="true"></span> Syncing…`;
    pill.hidden = !content;
    pill.className = cls;
    if (content) setHTML(pill, content);
    pill.setAttribute('role', 'status');
  }
  const streak = $('#streak-pill');
  if (streak) {
    const s = computeStreak(state.loggedDates).current;
    streak.hidden = s < 1;
    streak.textContent = `🔥 ${s}`;
    streak.title = `${s}-day logging streak`;
  }
  const tt = $('#theme-toggle');
  if (tt) {
    const pref = getThemePref();
    setHTML(tt, icon(pref === 'dark' ? 'moon' : pref === 'light' ? 'sun' : 'monitor'));
    tt.setAttribute('aria-label', `Theme: ${pref}. Change theme`);
  }
}
on('sync', updateShellStatus);
on('streak', updateShellStatus);
on('theme', updateShellStatus);

// ── PWA ───────────────────────────────────────────────────────────────────
function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg?.addEventListener?.('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) {
          toast('A new version of NutriLog is available.', 'info', { action: 'Reload', onAction: () => location.reload(), duration: 15000 });
        }
      });
    });
  }).catch((e) => console.warn('[NutriLog] service worker registration failed', e));
}

window.addEventListener('unhandledrejection', (e) => { console.error('[NutriLog] unhandled', e.reason); });

boot().catch((e) => {
  console.error('[NutriLog] boot failed', e);
  hideBoot();
  setHTML(appEl, html`<main class="auth"><div class="auth-panel center"><h2>Something went wrong</h2><p class="sub">${GENERIC_ERROR}</p><button type="button" class="btn btn-primary" id="reload-app">Reload</button></div></main>`);
  $('#reload-app')?.addEventListener('click', () => location.reload());
});
