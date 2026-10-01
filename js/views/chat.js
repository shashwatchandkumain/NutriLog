// Nutri AI coach: chat, day review and meal suggestions via the ai-chat Edge Function.
// Conversation text is kept only in this browser (per user, per day) as UI state.
import { html, setHTML, fmtInt } from '../lib/utils.js';
import { state } from '../store.js';
import { openSheet, showError, $ } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { coach } from '../services/ai.js';
import { openReview } from './food-logger.js';

const key = () => `nutrilog.chat.${state.user?.id}.${state.date}`;
const load = () => { try { return JSON.parse(sessionStorage.getItem(key())) || []; } catch { return []; } };
const save = (msgs) => { try { sessionStorage.setItem(key(), JSON.stringify(msgs.slice(-30))); } catch { /* ignore */ } };

const PROMPTS = ['Am I on track today?', 'High-protein vegetarian snack ideas?', 'I had 2 idli and sambar for breakfast'];

export function openCoach({ mode } = {}) {
  const sheet = openSheet({ title: 'Nutri AI', wide: true });
  let msgs = load();
  let busy = false;

  setHTML(sheet.body, html`
    <div class="chat">
      <div class="chat-msgs" id="c-msgs" aria-live="polite"></div>
      <form class="chat-input" id="c-form">
        <input class="input" id="c-input" maxlength="1000" autocomplete="off" placeholder="Ask about your diet, or tell me what you ate…" aria-label="Message">
        <button class="btn btn-primary" type="submit" aria-label="Send">${icon('chevronRight')}</button>
      </form>
    </div>`);
  const list = $('#c-msgs', sheet.body);
  const input = $('#c-input', sheet.body);

  const render = (typing = false) => {
    setHTML(list, html`
      ${msgs.length ? '' : html`<div class="msg system">Hi! I can review your day, suggest meals that fit your targets, or log food you describe.</div>
        <div class="chips" style="justify-content:center">${PROMPTS.map((p) => html`<button type="button" class="chip" data-prompt="${p}">${p}</button>`)}</div>`}
      ${msgs.map((m, i) => html`<div class="msg ${m.role === 'user' ? 'user' : m.error ? 'system' : 'ai'}">${m.content}${m.foods?.length ? html`
        <div class="food-suggest"><button type="button" class="btn btn-secondary btn-sm" data-add="${i}">${icon('plus', 14)} Review & add ${m.foods.length === 1 ? m.foods[0].food_name : `${m.foods.length} items`} (${fmtInt(m.foods.reduce((s, f) => s + f.calories, 0))} kcal)</button></div>` : ''}</div>`)}
      ${typing ? html`<div class="msg ai"><span class="typing" aria-label="Nutri AI is typing"><span></span><span></span><span></span></span></div>` : ''}`);
    list.scrollTop = list.scrollHeight;
  };

  const run = async (runMode, text) => {
    if (busy) return;
    busy = true;
    if (text) msgs.push({ role: 'user', content: text });
    else msgs.push({ role: 'user', content: runMode === 'day_review' ? 'Review my day' : 'Suggest what to eat next' });
    render(true);
    try {
      const history = msgs.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content }));
      const res = await coach(runMode, state.date, runMode === 'chat' ? history : []);
      msgs.push({ role: 'assistant', content: res.reply, foods: res.foods || [] });
    } catch (e) {
      msgs.push({ role: 'assistant', content: e?.userMessage || 'AI is unavailable right now. Please try again later.', error: true });
      if (!e?.userMessage) showError(e, 'coach');
    } finally {
      busy = false;
      save(msgs);
      render();
      input.focus();
    }
  };

  $('#c-form', sheet.body).addEventListener('submit', (e) => {
    e.preventDefault();
    const t = input.value.trim();
    if (!t) return;
    input.value = '';
    run('chat', t);
  });
  list.addEventListener('click', (e) => {
    const p = e.target.closest('[data-prompt]');
    if (p) { run('chat', p.dataset.prompt); return; }
    const a = e.target.closest('[data-add]');
    if (a) { const m = msgs[Number(a.dataset.add)]; if (m?.foods?.length) openReview(m.foods, { source: 'chat' }); }
  });

  render();
  if (mode === 'day_review' || mode === 'meal_plan') run(mode);
}
