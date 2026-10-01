// Daily logging reminder. Web pages can't schedule notifications on their own, so the
// reminder fires while NutriLog is open (or installed and running): at the chosen time, if
// nothing has been logged today, it shows a notification (or an in-app message).
import { state } from '../store.js';
import { today } from '../lib/utils.js';

let timer = null;
const firedKey = () => `nutrilog.reminded.${state.user?.id}.${today()}`;

export function notificationPermission() {
  return 'Notification' in window ? Notification.permission : 'unsupported';
}

export async function requestPermission() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'default') return Notification.requestPermission();
  return Notification.permission;
}

async function notify(title, body) {
  try {
    const reg = await navigator.serviceWorker?.getRegistration?.();
    if (reg && Notification.permission === 'granted') { await reg.showNotification(title, { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'nutrilog-reminder' }); return true; }
    if (Notification.permission === 'granted') { new Notification(title, { body, icon: 'icons/icon-192.png' }); return true; }
  } catch (e) { console.warn('[NutriLog] notification failed', e); }
  return false;
}

function check(onFallback) {
  const p = state.prefs;
  if (!p?.reminders_enabled || !state.user) return;
  const [h, m] = String(p.reminder_time || '20:00').split(':').map(Number);
  const now = new Date();
  if (now.getHours() * 60 + now.getMinutes() < h * 60 + m) return;
  try { if (localStorage.getItem(firedKey())) return; localStorage.setItem(firedKey(), '1'); } catch { return; }
  if (state.loggedDates.includes(today())) return;
  notify('NutriLog', "You haven't logged anything today. Take 30 seconds to add your meals.")
    .then((shown) => { if (!shown) onFallback?.(); });
}

export function startReminders(onFallback) {
  stopReminders();
  check(onFallback);
  timer = setInterval(() => check(onFallback), 60_000);
}

export function stopReminders() { clearInterval(timer); timer = null; }
