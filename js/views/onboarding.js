// First-run profile setup → personalised targets → optional recovery code → dashboard.
import { html, setHTML, today } from '../lib/utils.js';
import { recommendTargets } from '../lib/nutrition.js';
import { state } from '../store.js';
import { toast, showError, withBusy, $ } from '../ui/dom.js';
import { basicsFields, bodyFields, goalFields, activityFields, dietFields, bindProfileForm, readInto, validateProfile, profilePatch } from './profile-form.js';
import { saveProfile, savePrefs, saveGoals, logWeight } from '../services/data.js';
import { generateRecoveryCode } from '../services/auth.js';
import { targetsView, customTargetsForm, readCustomTargets } from './targets.js';

const STEPS = [
  { id: 'basics', title: "Let's set up your profile", lead: 'A few details to personalise your calorie and macro targets.', fields: basicsFields },
  { id: 'body', title: 'Your body', lead: 'Used to calculate how much energy you need each day.', fields: bodyFields },
  { id: 'goal', title: "What's your goal?", lead: 'You can change this any time in Settings.', fields: goalFields },
  { id: 'activity', title: 'How active are you?', lead: 'Include your usual workouts — NutriLog will not double-count them.', fields: activityFields },
  { id: 'diet', title: 'Food preferences', lead: 'Optional — helps AI suggestions fit what you eat.', fields: dietFields },
];

export function renderOnboarding(root, { onDone }) {
  const meta = state.user?.user_metadata || {};
  const model = {
    ...(state.profile || {}),
    display_name: state.profile?.display_name || meta.display_name || meta.full_name || meta.name || '',
    prefs: { weight_unit: state.prefs?.weight_unit || 'kg', height_unit: state.prefs?.height_unit || 'cm' },
  };
  let step = 0;
  let custom = null; // user-edited targets, if any

  const frame = (inner, stepIndex) => html`
    <main class="onboard">
      <span class="logo"><span class="logo-mark" aria-hidden="true">🥗</span><span>Nutri<strong>Log</strong></span></span>
      <div class="steps" aria-hidden="true">${[...STEPS, { id: 'plan' }].map((_, i) => html`<span class="${i <= stepIndex ? 'done' : ''}"></span>`)}</div>
      ${inner}
    </main>`;

  const renderStep = () => {
    const s = STEPS[step];
    setHTML(root, frame(html`
      <h1>${s.title}</h1><p class="lead">${s.lead}</p>
      <form class="stack" id="ob-form" novalidate>
        ${s.fields(model, model.prefs)}
        <div class="form-error hidden" role="alert"></div>
        <div class="onboard-foot">
          ${step > 0 ? html`<button type="button" class="btn btn-secondary" data-back>Back</button>` : ''}
          <button type="submit" class="btn btn-primary btn-lg">${step === STEPS.length - 1 ? 'See my plan' : 'Continue'}</button>
        </div>
      </form>`, step));
    const form = $('#ob-form', root);
    bindProfileForm(form, model, { onUnitChange: renderStep });
    form.querySelector('[data-back]')?.addEventListener('click', () => { readInto(form, model); step--; renderStep(); });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      readInto(form, model);
      const need = s.id === 'body' || s.id === 'basics';
      const errs = validateProfile(model, { requireBody: false }).concat(
        s.id === 'basics' && model.age == null ? ['Enter your age.'] : [],
        s.id === 'body' ? validateProfile(model).filter((x) => !/age/i.test(x)) : [],
      );
      if (need && errs.length) {
        const box = form.querySelector('.form-error');
        box.textContent = [...new Set(errs)].join(' ');
        box.classList.remove('hidden');
        return;
      }
      step++;
      if (step >= STEPS.length) renderPlan(); else renderStep();
      window.scrollTo({ top: 0 });
    });
    form.querySelector('input, select')?.focus();
  };

  const renderPlan = () => {
    const rec = recommendTargets(profilePatch(model));
    const t = custom || rec;
    setHTML(root, frame(html`
      <h1>Your daily plan</h1>
      <p class="lead">Based on your profile. You can fine-tune these now or later in Settings.</p>
      <div class="stack">
        ${targetsView(t, rec, model)}
        <details class="card" style="padding:14px" ${custom ? 'open' : ''}>
          <summary style="cursor:pointer;font-weight:600">Adjust targets manually</summary>
          <form id="ob-custom" class="stack" style="margin-top:12px" novalidate>${customTargetsForm(t)}
            <div class="row"><button class="btn btn-secondary btn-sm" type="submit">Apply</button>${custom ? html`<button class="btn btn-ghost btn-sm" type="button" data-reset>Use recommended</button>` : ''}</div>
          </form>
        </details>
        <div class="onboard-foot">
          <button type="button" class="btn btn-secondary" data-back>Back</button>
          <button type="button" class="btn btn-primary btn-lg" data-finish>Start tracking</button>
        </div>
      </div>`, STEPS.length));
    root.querySelector('[data-back]').addEventListener('click', () => { step = STEPS.length - 1; renderStep(); });
    const cf = $('#ob-custom', root);
    cf.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = readCustomTargets(cf);
      if (v.error) { toast(v.error, 'error'); return; }
      custom = { ...rec, ...v.targets };
      renderPlan();
    });
    root.querySelector('[data-reset]')?.addEventListener('click', () => { custom = null; renderPlan(); });
    root.querySelector('[data-finish]').addEventListener('click', (e) => withBusy(e.currentTarget, 'Saving your plan…', async () => {
      try {
        await savePrefs({ weight_unit: model.prefs.weight_unit, height_unit: model.prefs.height_unit });
        const target = custom || rec;
        await saveGoals({ calories: target.calories, protein: target.protein, carbs: target.carbs, fat: target.fat, fiber: target.fiber, isCustom: !!custom });
        await saveProfile({ ...profilePatch(model), start_weight_kg: state.profile?.start_weight_kg || profilePatch(model).weight_kg, onboarding_completed: true });
        logWeight(today(), profilePatch(model).weight_kg);
        renderRecovery();
      } catch (err) { showError(err, 'onboarding save'); }
    }));
  };

  const renderRecovery = () => {
    setHTML(root, frame(html`
      <h1>Save a recovery code</h1>
      <p class="lead">Optional, but recommended. If you ever lose access to your email, this code lets you reset your password. It works once, and we only store a scrambled version of it.</p>
      <div class="stack" id="rc-area">
        <button type="button" class="btn btn-primary btn-lg btn-block" data-gen>Create my recovery code</button>
        <button type="button" class="btn btn-ghost btn-block" data-skip>Skip for now</button>
      </div>`, STEPS.length));
    root.querySelector('[data-skip]').addEventListener('click', onDone);
    root.querySelector('[data-gen]').addEventListener('click', (e) => withBusy(e.currentTarget, 'Creating code…', async () => {
      try {
        const code = await generateRecoveryCode();
        setHTML($('#rc-area', root), html`
          <div class="code-box" aria-label="Your recovery code">${code}</div>
          <p class="small muted center">Write it down or store it in a password manager. It won't be shown again.</p>
          <div class="grid-2"><button type="button" class="btn btn-secondary" data-copy>Copy</button><button type="button" class="btn btn-secondary" data-dl>Download</button></div>
          <button type="button" class="btn btn-primary btn-lg btn-block" data-done>I've saved it — continue</button>`);
        root.querySelector('[data-copy]').addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(code); toast('Copied.', 'success'); } catch { toast('Copy failed — please write it down.', 'error'); }
        });
        root.querySelector('[data-dl]').addEventListener('click', () => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([`NutriLog recovery code for ${state.user?.email}\n\n${code}\n\nUse it at "Forgot password → Use a recovery code". It works once.\n`], { type: 'text/plain' }));
          a.download = 'nutrilog-recovery-code.txt'; a.click();
        });
        root.querySelector('[data-done]').addEventListener('click', onDone);
      } catch (err) {
        showError(err, 'recovery code');
        toast('You can create a recovery code later in Settings → Account.');
      }
    }));
  };

  renderStep();
}

