// AI features — every call goes to a Supabase Edge Function. The browser never holds a
// Gemini or Claude key; it sends the request with the user's session and gets results back.
// The model the user picked in Settings is sent along; the server falls back to the other one
// if it is unavailable and reports which model actually answered.
import { callFunction } from './supabase.js';
import { aiProvider } from '../store.js';
import { refreshEntitlementSoon } from './billing.js';

/** Calls an AI function, then refreshes the credit balance. */
const ai = (name, body) => callFunction(name, body).finally(() => refreshEntitlementSoon());

export const PROVIDER_LABEL = { gemini: 'Gemini', claude: 'Claude' };

/** → { items, provider } */
export async function analyzeFoodText(text) {
  const res = await ai('ai-food-analysis', { mode: 'text', text, provider: aiProvider() });
  return { items: res?.items || [], provider: res?.provider || aiProvider() };
}

/** → { items, provider } */
export async function analyzeFoodImage(image, note = '') {
  const res = await ai('ai-food-analysis', { mode: 'image', image: { mediaType: image.mediaType, base64: image.base64 }, text: note, provider: aiProvider() });
  return { items: res?.items || [], provider: res?.provider || aiProvider() };
}

/** Splits a meal description into foods with quantities — no nutrition. → { items, provider } */
export async function parseMealWithAi(text) {
  const res = await ai('ai-food-analysis', { mode: 'parse', text, provider: aiProvider() });
  return { items: res?.items || [], provider: res?.provider || aiProvider() };
}

/** Nutrition for foods the database doesn't know: items [{ food_name, preparation, quantity, unit, text_span }]. */
export async function estimateFoodsWithAi(items) {
  const res = await ai('ai-food-analysis', { mode: 'estimate', items, provider: aiProvider() });
  return { items: res?.items || [], provider: res?.provider || aiProvider() };
}

/** Activities with MET and minutes; `weightKg` is the user's weight on that day. → items */
export async function analyzeActivity(text, weightKg) {
  const res = await ai('ai-food-analysis', { mode: 'activity', text, weight_kg: weightKg, provider: aiProvider() });
  return res?.items || [];
}

/** mode: 'chat' | 'day_review' | 'meal_plan' → { reply, foods, provider } */
export async function coach(mode, date, messages = []) {
  return ai('ai-chat', { mode, date, messages, provider: aiProvider() });
}

/** Weekly AI report (Pro) for the 7 days ending `date`. → { report, id, created_at } */
export const weeklyReport = (date) => ai('ai-chat', { mode: 'weekly_report', date, provider: aiProvider() });

/** AI meal plan + grocery list (Pro AI) for 1 or 7 days. → { plan, id, created_at } */
export const mealPlan = (days) => ai('ai-chat', { mode: 'plan', days, provider: aiProvider() });
