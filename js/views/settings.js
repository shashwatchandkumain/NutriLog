// Settings: profile, nutrition & goals, units & appearance, connected devices, AI model,
// notifications, privacy, data (export / import / delete) and account.
import { html, setHTML, fmtInt, today, formatDay } from '../lib/utils.js';
import { recommendTargets, formatHeight, formatWeight } from '../lib/nutrition.js';
import { state, on, currentGoals, effectiveProfile, aiProvider, waterGoalMl, APP_VERSION } from '../store.js';
import { $, toast, showError, withBusy, confirmDialog, openSheet, download } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { applyTheme, getThemePref } from '../ui/theme.js';
import { basicsFields, bodyFields, goalFields, activityFields, dietFields, bindProfileForm, readInto, validateProfile, profilePatch } from './profile-form.js';
import { targetsView, customTargetsForm, readCustomTargets } from './targets.js';
import { saveProfile, savePrefs, saveGoals, logWeight, exportAll, deleteMyData } from '../services/data.js';
import { bluetoothSupport } from '../services/scale.js';
import * as auth from '../services/auth.js';
import { requestPermission, notificationPermission } from '../services/reminders.js';
import { openImport, openScale, openBluetoothHelp } from './lazy.js';

const SECTIONS = [['profile', 'Profile'], ['goals', 'Goals'], ['appearance', 'Appearance'], ['devices', 'Devices'], ['ai', 'AI'],
  ['notifications', 'Reminders'], ['privacy', 'Privacy'], ['data', 'Data'], ['account', 'Account']];

export function mountSettings(root, { onSignedOut }) {
  const disposers = [];

  const render = () => {
    const p = effectiveProfile();
    const prefs = state.prefs || {};
    const g = currentGoals();
    const exerciseMode = prefs.exercise_mode || 'included';
    const rec = recommendTargets(p, { exerciseMode });
    const provider = aiProvider();
    const shown = { calories: g.calories, protein: g.protein, carbs: g.carbs, fat: g.fat, fiber: g.fiber };
    const shortId = String(state.user?.id || '').slice(0, 8).toUpperCase();
    const themePref = getThemePref();
    const perm = notificationPermission();
    const bt = bluetoothSupport();
    setHTML(root, html`
      <div class="page-head"><h1>Settings</h1></div>
      <nav class="section-nav" aria-label="Settings sections">${SECTIONS.map(([id, label]) => html`<button type="button" class="chip" data-jump="${id}">${label}</button>`)}</nav>
      <div class="settings">
        <section class="card" id="sec-profile" aria-labelledby="s-profile">
          <div class="card-head"><h2 id="s-profile">Profile</h2><button type="button" class="btn btn-secondary btn-sm" data-edit-profile>${icon('edit', 16)} Edit</button></div>
          <dl class="kv">
            <dt>Name</dt><dd>${p.display_name || '—'}</dd>
            <dt>Age</dt><dd>${p.age ?? '—'}</dd>
            <dt>Sex</dt><dd>${p.sex ? p.sex[0].toUpperCase() + p.sex.slice(1) : 'Not specified'}</dd>
            <dt>Height</dt><dd>${formatHeight(Number(p.height_cm), prefs.height_unit)}</dd>
            <dt>Weight</dt><dd>${formatWeight(p.weight_kg, prefs.weight_unit)}</dd>
            <dt>Target weight</dt><dd>${p.target_weight_kg ? formatWeight(p.target_weight_kg, prefs.weight_unit) : '—'}</dd>
            <dt>Target date</dt><dd>${p.target_date ? formatDay(p.target_date, { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}</dd>
            <dt>Goal</dt><dd>${{ lose: 'Lose weight', maintain: 'Maintain weight', gain: 'Gain weight', muscle: 'Build muscle' }[p.goal] || '—'}</dd>
            <dt>Diet</dt><dd>${{ vegetarian: 'Vegetarian', eggetarian: 'Eggetarian', non_vegetarian: 'Non-vegetarian', vegan: 'Vegan' }[p.diet_type] || 'Not specified'}</dd>
            <dt>Allergies</dt><dd>${(p.allergies || []).join(', ') || 'None'}</dd>
          </dl>
        </section>

        <section class="card" id="sec-goals" aria-labelledby="s-goals">
          <div class="card-head"><h2 id="s-goals">Nutrition & goals</h2>
            <div class="segmented" role="group" aria-label="Target mode">
              <button type="button" data-goal-mode="auto" aria-pressed="${!g.isCustom}">Automatic</button>
              <button type="button" data-goal-mode="custom" aria-pressed="${g.isCustom}">Custom</button>
            </div></div>
          <div class="stack">
            ${targetsView(shown, rec, exerciseMode === 'add' ? { ...p, activity_level: 'sedentary' } : p, prefs.weight_unit)}
            ${g.isCustom && rec && rec.calories !== g.calories ? html`<div class="banner"><div class="grow"><b>You're using custom targets</b>Recommended for your current profile: ${fmtInt(rec.calories)} kcal, ${fmtInt(rec.protein)} g protein.</div><button type="button" class="btn btn-secondary btn-sm" data-use-rec>Use recommended</button></div>` : ''}
            ${g.isCustom ? html`<form id="s-custom" class="stack" novalidate>${customTargetsForm(shown)}<button class="btn btn-primary" type="submit">Save custom targets</button></form>` : ''}
            <div class="setting-row">
              <div><div class="t">Exercise calories</div><div class="d">${exerciseMode === 'add' ? 'Logged workouts are added to your daily budget.' : 'Your activity level already covers workouts (recommended).'}</div></div>
              <div class="segmented" role="group" aria-label="Exercise calories">
                <button type="button" data-ex-mode="included" aria-pressed="${exerciseMode === 'included'}">In activity level</button>
                <button type="button" data-ex-mode="add" aria-pressed="${exerciseMode === 'add'}">Add logged</button>
              </div>
            </div>
            <div class="setting-row">
              <div><div class="t">Daily water goal</div><div class="d">About 2–3 L for most adults; more when it's hot or you exercise.</div></div>
              <div class="input-group" style="width:150px"><input class="input" type="number" min="250" max="10000" step="250" value="${waterGoalMl()}" id="s-water" aria-label="Water goal in millilitres"><span class="input-suffix">ml</span></div>
            </div>
          </div>
        </section>

        <section class="card" id="sec-appearance" aria-labelledby="s-units">
          <h2 id="s-units">Units & appearance</h2>
          <div class="setting-row"><div class="t">Weight</div>
            <div class="segmented" role="group" aria-label="Weight unit">
              <button type="button" data-pref="weight_unit" data-v="kg" aria-pressed="${(prefs.weight_unit || 'kg') === 'kg'}">kg</button>
              <button type="button" data-pref="weight_unit" data-v="lb" aria-pressed="${prefs.weight_unit === 'lb'}">lb</button></div></div>
          <div class="setting-row"><div class="t">Height</div>
            <div class="segmented" role="group" aria-label="Height unit">
              <button type="button" data-pref="height_unit" data-v="cm" aria-pressed="${(prefs.height_unit || 'cm') === 'cm'}">cm</button>
              <button type="button" data-pref="height_unit" data-v="ftin" aria-pressed="${prefs.height_unit === 'ftin'}">ft / in</button></div></div>
          <div class="setting-row"><div class="t">Theme</div>
            <div class="segmented" role="group" aria-label="Theme">
              <button type="button" data-theme-set="light" aria-pressed="${themePref === 'light'}">${icon('sun', 16)} Light</button>
              <button type="button" data-theme-set="dark" aria-pressed="${themePref === 'dark'}">${icon('moon', 16)} Dark</button>
              <button type="button" data-theme-set="system" aria-pressed="${themePref === 'system'}">${icon('monitor', 16)} System</button></div></div>
        </section>

        <section class="card" id="sec-devices" aria-labelledby="s-devices">
          <h2 id="s-devices">${icon('bluetooth', 18)} Connected devices</h2>
          <div class="setting-row">
            <div><div class="t">Cult Smart Scale</div><div class="d">${bt === 'ok' ? 'Ready — this browser can connect over Bluetooth. NutriLog connects each time you measure; nothing stays paired.'
              : bt === 'ios' ? 'Safari can’t use Bluetooth. Open NutriLog in the Bluefy browser on iPhone or iPad to use the scale.' : 'This browser can’t use Bluetooth. Use Chrome or Edge to measure with the scale.'}</div></div>
            <div class="row"><button type="button" class="btn btn-ghost btn-sm" data-bt-help>Help</button><button type="button" class="btn btn-secondary btn-sm" data-measure>${icon('scale', 16)} Measure</button></div>
          </div>
        </section>

        <section class="card" id="sec-ai" aria-labelledby="s-ai">
          <h2 id="s-ai">${icon('sparkles', 18)} AI model</h2>
          <p class="sub">Used for food estimates (text and photos), activities and the Nutri AI coach. Both models get the same reference values for Indian staples and portions, and calories are always calculated from the protein, carbs and fat they estimate — so the two give consistent numbers.</p>
          <div class="setting-row">
            <div><div class="t">Analyze with</div><div class="d">${provider === 'claude' ? 'Claude (Anthropic) — detailed, careful estimates.' : 'Gemini (Google) — fast estimates.'} If the chosen model is unavailable, the other one answers.</div></div>
            <div class="segmented" role="group" aria-label="AI model">
              <button type="button" data-ai="gemini" aria-pressed="${provider === 'gemini'}">Gemini</button>
              <button type="button" data-ai="claude" aria-pressed="${provider === 'claude'}">Claude</button>
            </div>
          </div>
        </section>

        <section class="card" id="sec-notifications" aria-labelledby="s-notif">
          <h2 id="s-notif">Notifications</h2>
          <p class="sub">A gentle nudge if you haven't logged anything by your chosen time. Reminders appear while NutriLog is open or installed on this device.</p>
          <div class="setting-row">
            <div><div class="t">Daily logging reminder</div><div class="d">${perm === 'denied' ? 'Notifications are blocked in your browser settings — you will see an in-app message instead.' : perm === 'unsupported' ? 'This browser does not support notifications — you will see an in-app message instead.' : ''}</div></div>
            <label class="switch"><input type="checkbox" id="s-rem" ${prefs.reminders_enabled ? 'checked' : ''} aria-label="Daily logging reminder"><span></span></label>
          </div>
          <div class="setting-row"><div class="t">Reminder time</div><input class="input" type="time" id="s-rem-time" value="${String(prefs.reminder_time || '20:00').slice(0, 5)}" style="width:140px" ${prefs.reminders_enabled ? '' : 'disabled'}></div>
        </section>

        <section class="card" id="sec-privacy" aria-labelledby="s-privacy">
          <h2 id="s-privacy">${icon('lock', 18)} Privacy</h2>
          <p class="explain" style="margin-top:8px">Your data is stored in your personal account and protected by Supabase Row Level Security — only you can read or change it, on any device you log in to.</p>
          <p class="explain" style="margin-top:8px">When you use AI features, the description or photo you submit is sent to the AI model you chose (Google Gemini or Anthropic Claude) through NutriLog's secure server to estimate nutrition. NutriLog does not keep the photo. API keys never reach your browser.</p>
          <p class="explain" style="margin-top:8px">Smart-scale readings travel from the scale to this browser over Bluetooth and are saved only to your account.</p>
        </section>

        <section class="card" id="sec-data" aria-labelledby="s-data">
          <h2 id="s-data">Your data</h2>
          <div class="setting-row"><div><div class="t">Export my data</div><div class="d">Everything in your account as JSON, or your food log as CSV.</div></div>
            <div class="row"><button type="button" class="btn btn-secondary btn-sm" data-export="json">${icon('download', 16)} JSON</button><button type="button" class="btn btn-secondary btn-sm" data-export="csv">CSV</button></div></div>
          <div class="setting-row"><div><div class="t">Import a profile</div><div class="d">Bring in weigh-ins, meals and profile details from a NutriLog export (yours or someone else's) or a smart-scale (occult) backup with one or more profiles.</div></div>
            <button type="button" class="btn btn-secondary btn-sm" data-import>${icon('upload', 16)} Import</button></div>
          <div class="setting-row"><div><div class="t">Delete my data</div><div class="d">Erase all meals, weigh-ins, activities, water and favorites on every device. Your account, profile and targets stay.</div></div>
            <button type="button" class="btn btn-danger btn-sm" data-delete-data>${icon('trash', 16)} Delete data</button></div>
        </section>

        <section class="card" id="sec-account" aria-labelledby="s-account">
          <h2 id="s-account">Account</h2>
          <dl class="kv" style="margin:10px 0 4px">
            <dt>Email</dt><dd>${state.user?.email || '—'}</dd>
            <dt>Account ID</dt><dd><code>${shortId}</code></dd>
          </dl>
          <p class="hint">The Account ID helps identify your account if you contact support. It can't be used to log in.</p>
          <div class="setting-row"><div><div class="t">Password</div></div><button type="button" class="btn btn-secondary btn-sm" data-change-pw>Change password</button></div>
          <div class="setting-row"><div><div class="t">Recovery code</div><div class="d" id="s-rc-status">Checking…</div></div><button type="button" class="btn btn-secondary btn-sm" data-new-code>Create new code</button></div>
          <div class="setting-row"><div><div class="t">Sign out</div><div class="d">Your data stays in your account.</div></div>
            <div class="row"><button type="button" class="btn btn-ghost btn-sm" data-signout-all>All devices</button><button type="button" class="btn btn-secondary btn-sm" data-signout>${icon('logout', 16)} Log out</button></div></div>
        </section>

        <section class="card danger-zone" aria-labelledby="s-danger">
          <h2 id="s-danger">Delete account</h2>
          <p class="sub">Permanently deletes your account and all of your meals, weight history, goals and settings. This cannot be undone. Export your data first if you want a copy.</p>
          <button type="button" class="btn btn-danger" data-delete-account>${icon('trash', 16)} Delete my account</button>
        </section>

        <p class="center tiny faint">NutriLog ${APP_VERSION} · Nutrition values are estimates for guidance, not medical advice.</p>
      </div>`);
    auth.recoveryCodeStatus().then((s) => {
      const el = $('#s-rc-status', root);
      if (el) el.textContent = s?.has_code ? `Active since ${new Date(s.created_at).toLocaleDateString()}` : 'No active code — create one in case you lose email access.';
    });
  };

  // ── Handlers ────────────────────────────────────────────────────────
  root.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    try {
      if (t.matches('[data-jump]')) jumpTo(t.dataset.jump);
      else if (t.matches('[data-edit-profile]')) editProfile();
      else if (t.matches('[data-measure]')) openScale();
      else if (t.matches('[data-bt-help]')) openBluetoothHelp();
      else if (t.matches('[data-delete-data]')) deleteDataFlow();
      else if (t.matches('[data-goal-mode]')) {
        const custom = t.dataset.goalMode === 'custom';
        if (custom === currentGoals().isCustom) return;
        if (custom) { await withBusy(t, '…', () => saveGoals({ ...currentGoals(), isCustom: true })); }
        else await useRecommended(t);
      } else if (t.matches('[data-use-rec]')) await useRecommended(t);
      else if (t.matches('[data-ex-mode]')) {
        await withBusy(t, '…', () => savePrefs({ exercise_mode: t.dataset.exMode }));
        if (!currentGoals().isCustom) await applyRecommendation(true);
      } else if (t.matches('[data-pref]')) await withBusy(t, '…', () => savePrefs({ [t.dataset.pref]: t.dataset.v }));
      else if (t.matches('[data-ai]')) {
        if (t.dataset.ai === aiProvider()) return;
        await withBusy(t, '…', () => savePrefs({ ai_provider: t.dataset.ai }));
        toast(`AI model: ${t.dataset.ai === 'claude' ? 'Claude' : 'Gemini'}.`, 'success');
      } else if (t.matches('[data-import]')) openImport();
      else if (t.matches('[data-theme-set]')) {
        applyTheme(t.dataset.themeSet);
        render();
        savePrefs({ theme: t.dataset.themeSet }).catch((err) => console.warn('[NutriLog] theme sync', err));
      } else if (t.matches('[data-change-pw]')) changePassword();
      else if (t.matches('[data-new-code]')) newRecoveryCode(t);
      else if (t.matches('[data-signout]')) await withBusy(t, 'Signing out…', async () => { await auth.signOut('local'); onSignedOut(); });
      else if (t.matches('[data-signout-all]')) {
        if (await confirmDialog({ title: 'Sign out everywhere?', message: 'You will be logged out on all devices, including this one.', confirmLabel: 'Sign out everywhere' })) {
          await auth.signOut('global'); onSignedOut();
        }
      } else if (t.matches('[data-export]')) await withBusy(t, 'Exporting…', () => exportData(t.dataset.export));
      else if (t.matches('[data-delete-account]')) deleteAccountFlow();
    } catch (err) { showError(err, 'settings'); }
  });
  root.addEventListener('change', async (e) => {
    try {
      if (e.target.id === 's-water') {
        const ml = Math.round(Number(e.target.value));
        if (!(ml >= 250 && ml <= 10000)) { toast('Water goal must be between 250 and 10,000 ml.', 'error'); return; }
        await savePrefs({ water_goal_ml: ml }); toast('Water goal saved ✓', 'success');
      } else if (e.target.id === 's-rem') {
        const enabled = e.target.checked;
        if (enabled) await requestPermission();
        await savePrefs({ reminders_enabled: enabled });
      } else if (e.target.id === 's-rem-time') {
        await savePrefs({ reminder_time: e.target.value || '20:00' }); toast('Reminder time saved.', 'success');
      }
    } catch (err) { showError(err, 'settings'); }
  });
  root.addEventListener('submit', async (e) => {
    if (e.target.id !== 's-custom') return;
    e.preventDefault();
    const v = readCustomTargets(e.target);
    if (v.error) { toast(v.error, 'error'); return; }
    await withBusy(e.target.querySelector('[type=submit]'), 'Saving…', async () => {
      try { await saveGoals({ ...v.targets, isCustom: true }); toast('Custom targets saved. They won\'t change unless you change them.', 'success'); } catch (err) { showError(err); }
    });
  });

  async function applyRecommendation(silent) {
    const rec = recommendTargets(effectiveProfile(), { exerciseMode: state.prefs?.exercise_mode });
    if (!rec) { if (!silent) toast('Complete your profile first.', 'error'); return; }
    await saveGoals({ ...rec, isCustom: false });
    toast(`Targets updated: ${fmtInt(rec.calories)} kcal a day.`, 'success');
  }
  const useRecommended = (btn) => withBusy(btn, '…', () => applyRecommendation(false));

  function editProfile() {
    const model = { ...effectiveProfile(), prefs: { ...(state.prefs || {}) } };
    const sheet = openSheet({ title: 'Edit profile', wide: true, footer: true });
    const renderForm = () => {
      setHTML(sheet.body, html`<form class="stack" id="pf" novalidate>
        ${basicsFields(model, model.prefs)}<hr style="border:0;border-top:1px solid var(--border)">
        ${bodyFields(model, model.prefs)}<hr style="border:0;border-top:1px solid var(--border)">
        <span class="label">Goal</span>${goalFields(model)}<hr style="border:0;border-top:1px solid var(--border)">
        ${activityFields(model)}<hr style="border:0;border-top:1px solid var(--border)">
        ${dietFields(model)}
      </form>`);
      bindProfileForm($('#pf', sheet.body), model, { onUnitChange: renderForm });
    };
    renderForm();
    setHTML(sheet.foot, html`<button type="button" class="btn btn-secondary" data-cancel>Cancel</button><button type="button" class="btn btn-primary" data-save>Save</button>`);
    sheet.foot.querySelector('[data-cancel]').addEventListener('click', () => sheet.close());
    sheet.foot.querySelector('[data-save]').addEventListener('click', (e) => withBusy(e.currentTarget, 'Saving…', async () => {
      readInto($('#pf', sheet.body), model);
      const errs = validateProfile(model);
      if (errs.length) { toast(errs[0], 'error'); return; }
      try {
        const before = effectiveProfile();
        const patch = profilePatch(model);
        if (model.prefs.weight_unit !== state.prefs?.weight_unit || model.prefs.height_unit !== state.prefs?.height_unit) {
          await savePrefs({ weight_unit: model.prefs.weight_unit, height_unit: model.prefs.height_unit });
        }
        await saveProfile(patch);
        // Keep weight history consistent with an edited current weight.
        if (patch.weight_kg && Math.abs(Number(before.weight_kg || 0) - patch.weight_kg) >= 0.005) logWeight(today(), patch.weight_kg, { source: 'manual' });
        sheet.close();
        if (!currentGoals().isCustom) await applyRecommendation(true);
        else toast('Profile saved. Your custom targets were kept.', 'success');
      } catch (err) { showError(err, 'save profile'); }
    }));
  }

  function changePassword() {
    const sheet = openSheet({ title: 'Change password', footer: true });
    setHTML(sheet.body, html`<form class="stack" id="cp" novalidate>
      <div class="field"><label for="cp1">New password</label><input class="input" id="cp1" type="password" autocomplete="new-password" minlength="8" maxlength="72"></div>
      <div class="field"><label for="cp2">Confirm new password</label><input class="input" id="cp2" type="password" autocomplete="new-password"></div></form>`);
    setHTML(sheet.foot, html`<button type="button" class="btn btn-secondary" data-cancel>Cancel</button><button type="button" class="btn btn-primary" data-save>Save</button>`);
    sheet.foot.querySelector('[data-cancel]').addEventListener('click', () => sheet.close());
    sheet.foot.querySelector('[data-save]').addEventListener('click', (e) => withBusy(e.currentTarget, 'Saving…', async () => {
      // Trimmed like every other password field, so the new password works at login.
      const a = $('#cp1', sheet.body).value.trim(), b = $('#cp2', sheet.body).value.trim();
      if (a !== b) { toast("The passwords don't match.", 'error'); return; }
      try { await auth.updatePassword(a); sheet.close(); toast('Password changed.', 'success'); } catch (err) { toast(err.userMessage || auth.friendlyAuthError(err), 'error'); }
    }));
  }

  async function newRecoveryCode(btn) {
    const status = await auth.recoveryCodeStatus();
    if (status?.has_code && !(await confirmDialog({ title: 'Replace recovery code?', message: 'Your current recovery code will stop working.', confirmLabel: 'Create new code' }))) return;
    await withBusy(btn, 'Creating…', async () => {
      try {
        const code = await auth.generateRecoveryCode();
        const sheet = openSheet({ title: 'Your recovery code' });
        setHTML(sheet.body, html`<div class="stack"><div class="code-box">${code}</div>
          <p class="small muted">Save it somewhere safe. It won't be shown again and works once.</p>
          <button type="button" class="btn btn-secondary" data-copy>Copy</button></div>`);
        sheet.body.querySelector('[data-copy]').addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(code); toast('Copied.', 'success'); } catch { toast('Copy failed — please write it down.', 'error'); }
        });
        render();
      } catch (err) { showError(err, 'recovery code'); }
    });
  }

  async function exportData(kind) {
    const data = await exportAll();
    const stamp = today();
    if (kind === 'json') {
      download(`nutrilog-export-${stamp}.json`, JSON.stringify(data, null, 2), 'application/json');
    } else {
      const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const rows = [['date', 'meal', 'food', 'quantity', 'unit', 'grams', 'calories', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'source'].join(',')]
        .concat(data.meal_items.map((i) => [i.meal_date, i.meal_type, q(i.food_name), i.quantity, q(i.unit), i.grams ?? '', i.calories, i.protein, i.carbs, i.fat, i.fiber, i.source].join(',')));
      download(`nutrilog-food-log-${stamp}.csv`, rows.join('\n'), 'text/csv');
    }
    toast('Export downloaded.', 'success');
  }

  function jumpTo(id) {
    root.querySelector(`#sec-${id}`)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }

  async function deleteDataFlow() {
    const ok = await confirmDialog({
      title: 'Delete all your data?',
      message: 'This permanently erases every meal, weigh-in, activity, water entry and favorite in your account, on every device. Your account, profile and targets stay. Export your data first if you want a copy.',
      confirmLabel: 'Delete my data', danger: true, requireText: 'DELETE',
    });
    if (!ok) return;
    const sheet = openSheet({ title: 'Deleting your data…' });
    setHTML(sheet.body, html`<div class="empty"><div class="spinner" style="margin:0 auto 12px"></div><div class="empty-title">Deleting your data…</div></div>`);
    try {
      await deleteMyData();
      sheet.close();
      toast('Your data was deleted.', 'success');
    } catch (err) {
      sheet.close();
      showError(err, 'delete data');
    }
  }

  async function deleteAccountFlow() {
    const ok = await confirmDialog({
      title: 'Delete your account permanently?',
      message: 'This deletes your account and ALL of your data — meals, weight history, goals and settings — on every device. It cannot be undone.',
      confirmLabel: 'Delete forever', danger: true, requireText: 'DELETE',
    });
    if (!ok) return;
    const sheet = openSheet({ title: 'Deleting account…' });
    setHTML(sheet.body, html`<div class="empty"><div class="spinner" style="margin:0 auto 12px"></div><div class="empty-title">Deleting your account…</div></div>`);
    try {
      await auth.deleteAccount();
      sheet.close();
      toast('Your account and data were deleted.', 'success');
      onSignedOut({ deleted: true });
    } catch (err) {
      sheet.close();
      showError(err, 'delete account');
    }
  }

  disposers.push(on('account', render));
  disposers.push(on('theme', render));
  render();
  // Opened from a shortcut such as #/settings?s=data: scroll to that section.
  const section = /[?&]s=([a-z]+)/.exec(location.hash)?.[1];
  if (section) requestAnimationFrame(() => jumpTo(section));
  return () => disposers.forEach((d) => d());
}
