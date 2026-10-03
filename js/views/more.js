// More: everything outside the daily loop — activity, the AI coach, calendar, settings,
// data, help and log out.
import { html, setHTML } from '../lib/utils.js';
import { state, APP_VERSION } from '../store.js';
import { bindActions, withBusy } from '../ui/dom.js';
import { icon, avatar } from '../ui/icons.js';
import * as auth from '../services/auth.js';
import { navigate } from '../router.js';
import { openCoach, openCalendar, openTargetsExplainer, openBluetoothHelp } from './lazy.js';

export function mountMore(root, { onSignedOut }) {
  const inner = (o) => html`<span class="menu-icon" aria-hidden="true">${icon(o.icon, 20)}</span>
    <span class="grow"><b>${o.title}</b><span class="tiny muted">${o.sub}</span></span>${icon('chevronRight', 18)}`;
  const item = (o) => (o.href
    ? html`<a class="menu-item" href="${o.href}">${inner(o)}</a>`
    : html`<button type="button" class="menu-item" data-action="${o.action}">${inner(o)}</button>`);
  const name = state.profile?.display_name || '';
  setHTML(root, html`
    <div class="page-head"><h1>More</h1></div>
    <div class="settings">
      <a class="card profile-link" href="#/settings">${avatar(name || state.user?.email)}<span class="grow"><b>${name || 'Your profile'}</b><span class="tiny muted">${state.user?.email || ''}</span></span>${icon('chevronRight', 18)}</a>
      <section class="card menu" aria-label="Tools">
        ${item({ href: '#/activity', icon: 'activity', title: 'Activity & calories', sub: 'Log workouts, see energy in vs. out' })}
        ${item({ action: 'coach', icon: 'chat', title: 'Nutri AI coach', sub: 'Review your day, get meal ideas, ask anything' })}
        ${item({ action: 'calendar', icon: 'calendar', title: 'Calendar', sub: 'Jump to any day you logged' })}
        ${item({ action: 'explain', icon: 'target', title: 'How your target is calculated', sub: 'BMR → TDEE → goal → calories → macros' })}
      </section>
      <section class="card menu" aria-label="Settings">
        ${item({ href: '#/settings?s=goals', icon: 'target', title: 'Goals & nutrition', sub: 'Targets, goal date, exercise calories, water' })}
        ${item({ href: '#/settings?s=devices', icon: 'bluetooth', title: 'Connected devices', sub: 'Cult Smart Scale' })}
        ${item({ href: '#/settings?s=appearance', icon: 'sun', title: 'Units & appearance', sub: 'kg / lb, cm / ft, light / dark / system' })}
        ${item({ href: '#/settings?s=data', icon: 'download', title: 'Your data', sub: 'Export, import, delete' })}
        ${item({ href: '#/settings', icon: 'settings', title: 'All settings', sub: 'Profile, AI model, privacy, account' })}
      </section>
      <section class="card menu" aria-label="Help">
        ${item({ action: 'bt-help', icon: 'info', title: 'Bluetooth help', sub: 'Trouble connecting to the scale' })}
        ${state.isAdmin ? item({ href: '#/admin', icon: 'database', title: 'Food database (admin)', sub: 'Review new foods, reports and AI usage' }) : ''}
      </section>
      <button type="button" class="btn btn-secondary btn-block" data-action="logout">${icon('logout', 18)} Log out</button>
      <p class="center tiny faint">NutriLog ${APP_VERSION} · Nutrition values are estimates for guidance, not medical advice.</p>
    </div>`);
  const dispose = bindActions(root, {
    coach: () => openCoach(),
    calendar: () => openCalendar({ selected: state.date, onPick: (d) => { state.date = d; navigate('dashboard'); } }),
    explain: () => openTargetsExplainer(),
    'bt-help': () => openBluetoothHelp(),
    logout: (el) => withBusy(el, 'Logging out…', async () => { await auth.signOut('local'); onSignedOut(); }),
  });
  return dispose;
}
