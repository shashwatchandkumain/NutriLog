// Light / Dark / System theme. The choice is stored locally (applied before paint by
// theme-init.js) and synced to the account's preferences.
import { emit } from '../store.js';

const KEY = 'nutrilog.theme';
const media = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;

export function getThemePref() {
  try { return localStorage.getItem(KEY) || 'system'; } catch { return 'system'; }
}

export function resolvedTheme(pref = getThemePref()) {
  return pref === 'dark' || (pref === 'system' && media?.matches) ? 'dark' : 'light';
}

export function applyTheme(pref = getThemePref()) {
  if (!['light', 'dark', 'system'].includes(pref)) pref = 'system';
  try { localStorage.setItem(KEY, pref); } catch { /* storage blocked */ }
  const theme = resolvedTheme(pref);
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.setAttribute('data-theme-pref', pref);
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) { m.setAttribute('content', theme === 'dark' ? '#0d1315' : '#f8f7f2'); m.removeAttribute('media'); }
  emit('theme', { pref, theme });
}

media?.addEventListener?.('change', () => { if (getThemePref() === 'system') applyTheme('system'); });

export const nextTheme = (pref) => ({ system: 'light', light: 'dark', dark: 'system' }[pref] || 'system');
