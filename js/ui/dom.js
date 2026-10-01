// UI primitives: element lookup, event delegation, toasts, sheets (modals), confirm dialogs,
// and busy buttons that prevent double submission.
import { html, setHTML, friendlyError } from '../lib/utils.js';
import { icon } from './icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * Delegated handlers: `actions` maps data-action values to functions.
 * <button data-action="delete" data-id="…"> → actions.delete(el, event)
 */
export function bindActions(root, actions, events = ['click']) {
  const handler = (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || !root.contains(el)) return;
    const fn = actions[el.dataset.action];
    if (!fn) return;
    if (e.type === 'click' && el.tagName === 'A' && el.getAttribute('href') === '#') e.preventDefault();
    fn(el, e);
  };
  for (const ev of events) root.addEventListener(ev, handler);
  return () => { for (const ev of events) root.removeEventListener(ev, handler); };
}

// ── Toasts ────────────────────────────────────────────────────────────────
export function toast(message, type = 'info', { action, onAction, duration } = {}) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  const glyph = type === 'error' ? '!' : type === 'success' ? '✓' : 'i';
  setHTML(el, html`<span class="toast-icon" aria-hidden="true">${glyph}</span><span>${message}</span>${action ? html`<button class="toast-action" type="button">${action}</button>` : ''}`);
  if (action && onAction) el.querySelector('.toast-action').addEventListener('click', () => { onAction(); el.remove(); });
  host.appendChild(el);
  while (host.children.length > 3) host.firstElementChild.remove();
  setTimeout(() => el.remove(), duration || (type === 'error' ? 6000 : action ? 6000 : 3200));
}

/** Shows a friendly message for any error (details go to the console). */
export function showError(err, context) {
  toast(friendlyError(err, context), 'error');
}

// ── Busy buttons ──────────────────────────────────────────────────────────
/**
 * Disables `btn`, shows a spinner + label while `fn` runs, and restores it afterwards.
 * A second click while busy is ignored, so forms can't be submitted twice.
 */
export async function withBusy(btn, label, fn) {
  if (!btn) return fn();
  if (btn.dataset.busy === '1') return undefined;
  btn.dataset.busy = '1';
  const prev = btn.innerHTML;
  const prevDisabled = btn.disabled;
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  setHTML(btn, html`<span class="spinner" aria-hidden="true"></span><span>${label}</span>`);
  try {
    return await fn();
  } finally {
    if (btn.isConnected) {
      btn.innerHTML = prev;
      btn.disabled = prevDisabled;
      btn.removeAttribute('aria-busy');
    }
    delete btn.dataset.busy;
  }
}

// ── Sheets (modals / bottom sheets) ───────────────────────────────────────
const openSheets = [];

/**
 * Opens a sheet. `render(body)` fills it; returns { el, body, close, setTitle }.
 * Esc and the backdrop close it; focus is moved in and restored on close.
 */
export function openSheet({ title, wide = false, onClose, footer = false } = {}) {
  const root = document.getElementById('modal-root');
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  const titleId = `sheet-title-${Math.random().toString(36).slice(2)}`;
  setHTML(overlay, html`
    <div class="sheet ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="${titleId}" tabindex="-1">
      <div class="sheet-head">
        <h2 id="${titleId}">${title || ''}</h2>
        <button class="icon-btn" type="button" data-close aria-label="Close">${icon('x')}</button>
      </div>
      <div class="sheet-body"></div>
      ${footer ? html`<div class="sheet-foot"></div>` : ''}
    </div>`);
  const sheet = overlay.querySelector('.sheet');
  const previousFocus = document.activeElement;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    const i = openSheets.indexOf(api);
    if (i >= 0) openSheets.splice(i, 1);
    if (!openSheets.length) document.body.style.overflow = '';
    onClose?.();
    if (previousFocus?.focus) previousFocus.focus({ preventScroll: true });
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && openSheets[openSheets.length - 1] === api) { e.stopPropagation(); close(); }
    if (e.key === 'Tab') trapFocus(sheet, e);
  };
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('[data-close]').addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  root.appendChild(overlay);
  document.body.style.overflow = 'hidden';
  const api = {
    el: sheet,
    body: sheet.querySelector('.sheet-body'),
    foot: sheet.querySelector('.sheet-foot'),
    close,
    get closed() { return closed; },
    setTitle(t) { sheet.querySelector(`#${titleId}`).textContent = t; },
  };
  openSheets.push(api);
  requestAnimationFrame(() => {
    const first = sheet.querySelector('input, textarea, select, [autofocus]');
    (first || sheet).focus({ preventScroll: true });
  });
  return api;
}

export function closeAllSheets() {
  for (const s of [...openSheets]) s.close();
}

function trapFocus(container, e) {
  const f = $$('button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])', container)
    .filter((el) => el.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

/**
 * Confirmation dialog. Resolves true/false. With `requireText`, the user must type it
 * (used for permanent actions like deleting the account).
 */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, requireText = null }) {
  return new Promise((resolve) => {
    let result = false;
    const s = openSheet({ title, footer: true, onClose: () => resolve(result) });
    setHTML(s.body, html`
      <p class="muted">${message}</p>
      ${requireText ? html`<div class="field" style="margin-top:14px">
        <label for="confirm-text">Type <b>${requireText}</b> to confirm</label>
        <input class="input" id="confirm-text" autocomplete="off" autocapitalize="characters" spellcheck="false">
      </div>` : ''}`);
    setHTML(s.foot, html`
      <button class="btn btn-secondary" type="button" data-cancel>Cancel</button>
      <button class="btn ${danger ? 'btn-danger-solid' : 'btn-primary'}" type="button" data-ok ${requireText ? 'disabled' : ''}>${confirmLabel}</button>`);
    const ok = s.foot.querySelector('[data-ok]');
    if (requireText) {
      s.body.querySelector('#confirm-text').addEventListener('input', (e) => { ok.disabled = e.target.value.trim() !== requireText; });
    }
    s.foot.querySelector('[data-cancel]').addEventListener('click', () => s.close());
    ok.addEventListener('click', () => { result = true; s.close(); });
  });
}

/** Reads a form's fields into an object (by name). */
export function formData(form) {
  const out = {};
  for (const [k, v] of new FormData(form).entries()) out[k] = typeof v === 'string' ? v.trim() : v;
  return out;
}

export function download(filename, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
