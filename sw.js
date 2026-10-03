// NutriLog service worker.
//  - App shell (HTML/CSS/JS/icons): precached per version → works offline.
//  - Navigation: network-first, falls back to the cached shell when offline.
//  - CDN libraries & fonts: stale-while-revalidate.
//  - Supabase, Edge Functions, Open Food Facts: never intercepted or cached — personal
//    data and auth tokens are never written to the service-worker cache.
// The deploy workflow replaces VERSION with the commit SHA; bump it manually otherwise.
const VERSION = '2.3.0';
const SHELL_CACHE = `nutrilog-shell-${VERSION}`;
const CDN_CACHE = 'nutrilog-cdn-v1';

const SHELL = [
  './', './index.html', './manifest.json', './css/app.css',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
  './js/app.js', './js/config.js', './js/router.js', './js/store.js', './js/theme-init.js',
  './js/lib/activity.js', './js/lib/body-composition.js', './js/lib/food-key.js', './js/lib/food-library.js', './js/lib/food-resolve.js', './js/lib/import-formats.js', './js/lib/meal-parser.js',
  './js/lib/nutrition.js', './js/lib/scale-protocol.js', './js/lib/stats.js', './js/lib/utils.js',
  './js/services/ai.js', './js/services/auth.js', './js/services/data.js', './js/services/food-db.js', './js/services/foods.js', './js/services/meal-analysis.js',
  './js/services/reminders.js', './js/services/scale.js', './js/services/supabase.js', './js/services/voice.js',
  './js/ui/charts.js', './js/ui/dom.js', './js/ui/icons.js', './js/ui/theme.js',
  './js/views/activity-log.js', './js/views/activity.js', './js/views/admin.js', './js/views/auth.js', './js/views/calendar.js',
  './js/views/chat.js', './js/views/dashboard.js', './js/views/food-logger.js', './js/views/food.js',
  './js/views/import.js', './js/views/lazy.js', './js/views/meals.js', './js/views/measure.js', './js/views/more.js',
  './js/views/onboarding.js', './js/views/profile-form.js', './js/views/progress.js', './js/views/serving-picker.js', './js/views/settings.js',
  './js/views/targets.js', './js/views/weigh-in.js',
];
const CDN_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('nutrilog-shell-') && k !== SHELL_CACHE).map((k) => caches.delete(k)));
    // Remove caches from the previous app version.
    await Promise.all(keys.filter((k) => k.startsWith('nutrilog-v')).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (req.mode === 'navigate') {
      event.respondWith((async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(SHELL_CACHE);
          cache.put('./index.html', fresh.clone());
          return fresh;
        } catch {
          return (await caches.match('./index.html')) || (await caches.match('./')) || Response.error();
        }
      })());
      return;
    }
    event.respondWith((async () => {
      const cached = await caches.match(req, { ignoreSearch: true });
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') (await caches.open(SHELL_CACHE)).put(req, res.clone());
      return res;
    })());
    return;
  }

  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CDN_CACHE);
      const cached = await cache.match(req);
      const network = fetch(req).then((res) => { if (res.ok || res.type === 'opaque') cache.put(req, res.clone()); return res; }).catch(() => cached);
      return cached || network;
    })());
  }
  // Everything else (Supabase, Edge Functions, Open Food Facts) goes straight to the network.
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = all.find((c) => c.url.startsWith(self.registration.scope));
    if (client) return client.focus();
    return self.clients.openWindow('./#/dashboard');
  })());
});
