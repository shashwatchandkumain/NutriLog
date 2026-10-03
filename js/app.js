// NutriLog entry point: auth-gated routing, the app shell (sidebar on desktop, bottom
// navigation on phones), sync & realtime wiring, automatic targets and app updates.
//
//   open site → no session      → welcome / log in / create account
//             → session, new     → profile setup (onboarding)
//             → session          → dashboard (restored instantly from cache, then synced)
import { html, setHTML, GENERIC_ERROR, debounce, today, fmtInt } from './lib/utils.js';
import { formatWeight } from './lib/nutrition.js';
import { computeStreak } from './lib/stats.js';
import { state, on, emit } from './store.js';
import { configProblem } from './services/supabase.js';
import * as auth from './services/auth.js';
import * as data from './services/data.js';
import { startReminders, stopReminders } from './services/reminders.js';
import { currentRoute, navigate, clearAuthFragment } from './router.js';
import { toast, closeAllSheets, openSheet, confirmDialog, showError, $, $$ } from './ui/dom.js';
import { icon, avatar } from './ui/icons.js';
import { applyTheme, getThemePref, nextTheme } from './ui/theme.js';
import { renderWelcome, renderSignup, renderLogin, renderForgot, renderRecoverCode, renderCheckEmail, renderSetPassword } from './views/auth.js';
import { renderOnboarding } from './views/onboarding.js';
import { mountDashboard } from './views/dashboard.js';
import { openFoodLogger } from './views/food-logger.js';
import { openCoach } from './views/lazy.js';
import { isAdmin, clearFoodCache } from './services/food-db.js';

const appEl = document.getElementById('app');
const AUTH_ROUTES = new Set(['welcome', 'signup', 'login', 'forgot', 'recover', 'check-email']);
// The dashboard ships with the app; other screens load on first visit (the service worker
// precaches them, so later visits are instant and work offline).
const ROUTES = {
  dashboard: { title: 'Dashboard', tab: 'dashboard', load: () => Promise.resolve({ mount: mountDashboard }) },
  food: { title: 'Food', tab: 'food', load: () => import('./views/food.js').then((m) => ({ mount: m.mountFood })) },
  progress: { title: 'Progress', tab: 'progress', load: () => import('./views/progress.js').then((m) => ({ mount: m.mountProgress })) },
  measure: { title: 'Measure', tab: 'measure', load: () => import('./views/measure.js').then((m) => ({ mount: m.mountMeasure })) },
  activity: { title: 'Activity', tab: 'more', load: () => import('./views/activity.js').then((m) => ({ mount: m.mountActivity })) },
  settings: { title: 'Settings', tab: 'more', load: () => import('./views/settings.js').then((m) => ({ mount: m.mountSettings })) },
  more: { title: 'More', tab: 'more', load: () => import('./views/more.js').then((m) => ({ mount: m.mountMore })) },
  admin: { title: 'Food database', tab: 'more', load: () => import('./views/admin.js').then((m) => ({ mount: m.mountAdmin })) },
};
const ALIASES = { calories: 'activity' };
const initialHash = window.__nutrilogInitialHash || '';

let shellMounted = false;
let unmountView = null;
let viewRoute = null;
let renderSeq = 0;
let bootstrappedFor = null;
let accountError = null;
let lastWeighIn = null;      // latest weigh-in seen, to announce target changes it causes
let announceTargets = false;

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

const logo = (size = '') => html`<span class="logo ${size}"><span class="logo-mark" aria-hidden="true">🥗</span><span>Nutri<strong>Log</strong></span></span>`;

function renderConfigProblem() {
  const secret = configProblem === 'secret-key';
  setHTML(appEl, html`<main class="auth"><div class="auth-card"><div class="auth-panel">
    ${logo()}
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
    setBootText('Checking your session…');
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
  data.fetchFavorites().catch((e) => console.warn('[NutriLog] favorites', e.message));
  isAdmin().then((yes) => { if (bootstrappedFor === user.id) state.isAdmin = yes; });
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
  startReminders(() => toast("Reminder: you haven't logged anything today.", 'info', { action: 'Log food', onAction: () => openFoodLogger() }));
}

function teardownUser() {
  data.unsubscribeRealtime();
  stopReminders();
  data.endDataSession();
  bootstrappedFor = null;
  Object.assign(state, { profile: null, prefs: null, goals: null, day: null, weights: [], loggedDates: [], favorites: [], date: today(), passwordRecovery: false, isAdmin: false });
  clearFoodCache();
  lastWeighIn = null;
  announceTargets = false;
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
const refreshFavorites = debounce(() => data.fetchFavorites().catch(() => {}), 500);
const refreshDates = debounce(() => data.fetchLoggedDates().then(updateShellStatus).catch(() => {}), 800);
const refreshDay = debounce(() => { emit('remote-day', state.date); emit('data-changed'); }, 400);

function onRemoteChange(table) {
  if (table === 'meal_items' || table === 'activities' || table === 'water_logs') { refreshDay(); if (table === 'meal_items') refreshDates(); }
  else if (table === 'weight_history') refreshWeights();
  else if (table === 'favorite_foods') refreshFavorites();
  else refreshAccount();
}

// Keep "today" current: if the app stays open past midnight, move from yesterday to the new day.
let knownToday = today();
function checkDayRollover() {
  const now = today();
  if (now === knownToday) return;
  const followed = state.date === knownToday;
  knownToday = now;
  if (followed && bootstrappedFor) { state.date = now; emit('remote-day', now); emit('data-changed'); updateShellStatus(); }
}
setInterval(checkDayRollover, 60_000);

let lastFocusRefresh = Date.now();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !bootstrappedFor) return;
  checkDayRollover();
  data.flush();
  if (Date.now() - lastFocusRefresh > 30_000) {
    lastFocusRefresh = Date.now();
    refreshDay(); refreshAccount(); refreshWeights(); refreshDates(); refreshFavorites();
  }
});
window.addEventListener('online', () => { state.online = true; emit('sync'); data.flush(); if (bootstrappedFor) refreshDay(); });
window.addEventListener('offline', () => { state.online = false; emit('sync'); });
on('toast', ({ message, type }) => toast(message, type));

// ── Automatic targets ─────────────────────────────────────────────────────
// Non-custom targets follow the latest weigh-in, the profile and the goal date.
const latestWeighInKey = () => { const w = state.weights[state.weights.length - 1]; return w ? `${w.recorded_on}:${w.weight_kg}` : null; };
const runTargetSync = debounce(async () => {
  if (!bootstrappedFor) return;
  const announce = announceTargets;
  announceTargets = false;
  try {
    const r = await data.syncAutoTargets();
    if (r && announce) {
      const w = state.weights[state.weights.length - 1];
      toast(`Targets updated for ${formatWeight(w?.weight_kg, state.prefs?.weight_unit)}: ${fmtInt(r.after.calories)} kcal a day.`, 'success');
    }
  } catch (e) { console.warn('[NutriLog] target sync', e); }
}, 700);
const syncTargets = (announce) => { announceTargets ||= announce; runTargetSync(); };
on('account', () => syncTargets(false));
on('weights', () => {
  const key = latestWeighInKey();
  const changed = lastWeighIn !== null && key !== lastWeighIn;
  lastWeighIn = key;
  syncTargets(changed);
});

// ── Rendering ─────────────────────────────────────────────────────────────
function unmountApp() {
  unmountView?.(); unmountView = null; viewRoute = null;
  shellMounted = false;
}

function render() {
  const raw = currentRoute();
  const route = ALIASES[raw] || raw;
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

  const target = ROUTES[route] ? route : 'dashboard';
  if (raw !== target) history.replaceState(null, '', `#/${target}`);
  mountShell();
  if (viewRoute === target) return;
  mountRoute(target);
}

async function mountRoute(target) {
  const seq = ++renderSeq;
  unmountView?.();
  unmountView = null;
  viewRoute = target;
  const main = $('#view');
  const container = document.createElement('div');
  container.className = 'view';
  main.replaceChildren(container);
  setNavState(target);
  document.title = `${ROUTES[target].title} · NutriLog`;
  window.scrollTo({ top: 0 });
  let mod;
  try {
    mod = await ROUTES[target].load();
  } catch (e) {
    if (seq !== renderSeq) return;
    showError(e, `open ${target}`);
    setHTML(container, html`<div class="error-state"><div class="empty-title">Couldn't open this page</div>
      <p class="small muted">${navigator.onLine ? 'Something went wrong. Please try again.' : "You're offline and this page hasn't been saved on this device yet."}</p>
      <button type="button" class="btn btn-secondary btn-sm" data-retry-route>Retry</button></div>`);
    container.querySelector('[data-retry-route]').addEventListener('click', () => { viewRoute = null; render(); });
    return;
  }
  if (seq !== renderSeq) return; // the user navigated elsewhere while it loaded
  unmountView = mod.mount(container, { onSignedOut: signedOut });
}

const SIDE_NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: 'home' },
  { id: 'food', label: 'Food', icon: 'utensils' },
  { id: 'progress', label: 'Progress', icon: 'chart' },
  { id: 'measure', label: 'Measure', icon: 'scale' },
  { id: 'activity', label: 'Activity', icon: 'flame' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];
const BOTTOM_NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: 'home' },
  { id: 'food', label: 'Food', icon: 'utensils' },
  { id: 'progress', label: 'Progress', icon: 'chart' },
  { id: 'measure', label: 'Measure', icon: 'scale' },
  { id: 'more', label: 'More', icon: 'menu' },
];

function setNavState(target) {
  for (const a of $$('[data-nav]')) {
    const current = a.dataset.nav === target || (a.closest('.bottomnav') && a.dataset.nav === ROUTES[target].tab);
    if (current) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}

function mountShell() {
  if (shellMounted) return;
  shellMounted = true;
  setHTML(appEl, html`
    <a class="skip-link" href="#view">Skip to content</a>
    <aside class="sidebar" aria-label="NutriLog">
      <a class="side-logo" href="#/dashboard" aria-label="NutriLog home">${logo()}</a>
      <button type="button" class="btn btn-primary btn-block" data-shell="log">${icon('plus', 18)} Log food</button>
      <nav class="side-nav" aria-label="Main">
        ${SIDE_NAV.map((n) => html`<a href="#/${n.id}" data-nav="${n.id}">${icon(n.icon, 20)}<span>${n.label}</span></a>`)}
        <button type="button" data-shell="coach">${icon('chat', 20)}<span>Nutri AI coach</span></button>
      </nav>
      <div class="side-foot">
        <button type="button" class="sync-pill" data-sync hidden></button>
        <div class="row between"><span class="streak-pill" data-streak hidden></span><button type="button" class="icon-btn" data-shell="theme"></button></div>
        <a class="side-user" href="#/settings" data-user></a>
      </div>
    </aside>
    <header class="topbar">
      <a class="logo-link" href="#/dashboard" aria-label="NutriLog home">${logo()}</a>
      <div class="topbar-right">
        <button type="button" class="sync-pill" data-sync hidden></button>
        <span class="streak-pill" data-streak hidden></span>
        <button type="button" class="icon-btn" data-shell="theme"></button>
        <a class="avatar-link" href="#/settings" data-avatar aria-label="Profile and settings"></a>
      </div>
    </header>
    <main class="main" id="view" tabindex="-1"></main>
    <nav class="bottomnav" aria-label="Main">${BOTTOM_NAV.map((n) => html`<a href="#/${n.id}" data-nav="${n.id}">${icon(n.icon)}<span>${n.label}</span></a>`)}</nav>
    <button type="button" class="fab" data-shell="log" aria-label="Log food">${icon('plus')}</button>`);
  updateShellStatus();
}

// One listener for the whole app root (it survives the shell being re-rendered after login).
appEl.addEventListener('click', onShellClick);

function onShellClick(e) {
  const b = e.target.closest('[data-shell], [data-sync]');
  if (!b || !appEl.contains(b)) return;
  if (b.matches('[data-sync]')) { if (state.failed) openFailedChanges(); return; }
  const action = b.dataset.shell;
  if (action === 'log') openFoodLogger();
  else if (action === 'coach') openCoach();
  else if (action === 'theme') {
    const next = nextTheme(getThemePref());
    applyTheme(next);
    toast(`Theme: ${next[0].toUpperCase()}${next.slice(1)}`);
    data.savePrefs({ theme: next }).catch((err) => console.warn('[NutriLog] theme sync', err.message));
  }
}

/** Changes the server rejected: retry them, or discard them after confirming. */
function openFailedChanges() {
  const list = data.failedChanges();
  const sheet = openSheet({ title: 'Changes not saved', footer: true });
  setHTML(sheet.body, html`<div class="stack">
    <p class="muted">${list.length === 1 ? 'This change' : `These ${list.length} changes`} couldn't be saved to your account. They are kept on this device — try again, or discard them.</p>
    <div class="stack-sm">${list.map((c) => html`<div class="item"><div class="item-main"><div class="item-name">${c.label[0].toUpperCase()}${c.label.slice(1)}</div>
      <div class="item-meta">${c.date ? `for ${c.date} · ` : ''}failed ${new Date(c.failedAt).toLocaleString()}</div></div></div>`)}</div></div>`);
  setHTML(sheet.foot, html`<button type="button" class="btn btn-secondary" data-discard>Discard</button><button type="button" class="btn btn-primary" data-retry>Try again</button>`);
  sheet.foot.querySelector('[data-retry]').addEventListener('click', () => { sheet.close(); data.retryFailed(); toast('Trying again…'); });
  sheet.foot.querySelector('[data-discard]').addEventListener('click', async () => {
    sheet.close();
    if (await confirmDialog({ title: 'Discard these changes?', message: "They will be removed from this device and won't be saved.", confirmLabel: 'Discard', danger: true })) {
      data.discardFailed();
      toast('Discarded.');
    }
  });
}

function updateShellStatus() {
  if (!shellMounted) return;
  let content = null, cls = 'sync-pill', label = '';
  if (state.failed) { cls += ' failed'; content = html`${icon('alert', 14)} ${state.failed} not saved`; label = `${state.failed} change${state.failed === 1 ? '' : 's'} not saved. Review`; }
  else if (!state.online) { cls += ' offline'; content = html`${icon('cloudOff', 14)} Offline${state.pending ? ` · ${state.pending} to sync` : ''}`; label = 'Offline'; }
  else if (state.syncing || state.pending) { content = html`<span class="spinner" aria-hidden="true"></span> Syncing…`; label = 'Syncing'; }
  for (const pill of $$('[data-sync]')) {
    pill.hidden = !content;
    pill.className = cls;
    pill.disabled = !state.failed;
    if (content) setHTML(pill, content);
    pill.setAttribute('aria-label', label);
  }
  const s = computeStreak(state.loggedDates).current;
  for (const el of $$('[data-streak]')) {
    el.hidden = s < 1;
    el.textContent = `🔥 ${s}`;
    el.title = `${s}-day logging streak`;
  }
  const pref = getThemePref();
  for (const tt of $$('[data-shell="theme"]')) {
    setHTML(tt, icon(pref === 'dark' ? 'moon' : pref === 'light' ? 'sun' : 'monitor'));
    tt.setAttribute('aria-label', `Theme: ${pref}. Change theme`);
  }
  const name = state.profile?.display_name || '';
  const email = state.user?.email || '';
  for (const a of $$('[data-avatar]')) setHTML(a, avatar(name || email));
  for (const a of $$('[data-user]')) setHTML(a, html`${avatar(name || email)}<span class="grow"><b>${name || 'Your profile'}</b><span class="tiny muted">${email}</span></span>`);
}
on('sync', updateShellStatus);
on('streak', updateShellStatus);
on('theme', updateShellStatus);
on('account', updateShellStatus);

// ── PWA ───────────────────────────────────────────────────────────────────
function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  let reloading = false;
  // A new version takes over only when the user agrees; then reload once into it. On a first
  // visit the worker also takes control, but there is nothing to update, so that one change
  // doesn't reload — every later one (an update, also from another tab) does.
  let controlled = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!controlled) { controlled = true; return; }
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const offer = (worker) => toast('A new version of NutriLog is available.', 'info', {
      action: 'Update', duration: 20000,
      onAction: () => worker.postMessage('skip-waiting'),
    });
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
      });
    });
    // Long-lived sessions (an installed app left open) check for updates when they come back.
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch((e) => console.warn('[NutriLog] service worker registration failed', e));
}

window.addEventListener('unhandledrejection', (e) => { console.error('[NutriLog] unhandled', e.reason); });

boot().catch((e) => {
  console.error('[NutriLog] boot failed', e);
  hideBoot();
  setHTML(appEl, html`<main class="auth"><div class="auth-panel center"><h2>Something went wrong</h2><p class="sub">${GENERIC_ERROR}</p><button type="button" class="btn btn-primary" id="reload-app">Reload</button></div></main>`);
  $('#reload-app')?.addEventListener('click', () => location.reload());
});
