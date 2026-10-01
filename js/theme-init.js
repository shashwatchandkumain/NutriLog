// Runs synchronously in <head> before the page paints, so dark mode never flashes white.
// Classic script (not a module) on purpose.
(function () {
  // Remember the URL fragment before Supabase consumes it (used to detect password-reset links).
  window.__nutrilogInitialHash = location.hash;
  var pref = 'system';
  try { pref = localStorage.getItem('nutrilog.theme') || 'system'; } catch (e) { /* storage blocked */ }
  var dark = pref === 'dark' || (pref === 'system' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  var root = document.documentElement;
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
  root.setAttribute('data-theme-pref', pref);
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#0d1315' : '#f8f7f2');
})();
