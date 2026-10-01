// Hash routing (#/dashboard, #/settings …). Hash URLs work on GitHub Pages without any
// server rewrite rules, and all asset paths stay relative so /NutriLog/ works as a base.

/** Current route name, ignoring Supabase auth fragments (#access_token=…, #error=…). */
export function currentRoute() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  if (/(^|&)(access_token|refresh_token|error|error_description|type)=/.test(h)) return '';
  return h.split(/[?&]/)[0] || '';
}

export function navigate(route, { replace = false } = {}) {
  const target = `#/${route}`;
  if (location.hash === target) { window.dispatchEvent(new HashChangeEvent('hashchange')); return; }
  if (replace) {
    history.replaceState(null, '', target);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    location.hash = target;
  }
}

/** Removes auth tokens from the address bar once Supabase has read them. */
export function clearAuthFragment() {
  if (/access_token|error_description|refresh_token/.test(location.hash)) {
    history.replaceState(null, '', `${location.pathname}${location.search}#/`);
  }
}
