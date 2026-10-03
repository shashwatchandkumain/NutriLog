// AI features — every call goes to a Supabase Edge Function. The browser never holds a
// Gemini or Claude key; it sends the request with the user's session and gets results back.
// The model the user picked in Settings is sent along; the server falls back to the other one
// if it is unavailable and reports which model actually answered.
import { callFunction } from './supabase.js';
import { aiProvider } from '../store.js';

export const PROVIDER_LABEL = { gemini: 'Gemini', claude: 'Claude' };

/** → { items, provider } */
export async function analyzeFoodText(text) {
  const res = await callFunction('ai-food-analysis', { mode: 'text', text, provider: aiProvider() });
  return { items: res?.items || [], provider: res?.provider || aiProvider() };
}

/** → { items, provider } */
export async function analyzeFoodImage(image, note = '') {
  const res = await callFunction('ai-food-analysis', { mode: 'image', image: { mediaType: image.mediaType, base64: image.base64 }, text: note, provider: aiProvider() });
  return { items: res?.items || [], provider: res?.provider || aiProvider() };
}

/** Splits a meal description into foods with quantities — no nutrition. → { items, provider } */
export async function parseMealWithAi(text) {
  const res = await callFunction('ai-food-analysis', { mode: 'parse', text, provider: aiProvider() });
  return { items: res?.items || [], provider: res?.provider || aiProvider() };
}

/** Nutrition for foods the database doesn't know: items [{ food_name, preparation, quantity, unit, text_span }]. */
export async function estimateFoodsWithAi(items) {
  const res = await callFunction('ai-food-analysis', { mode: 'estimate', items, provider: aiProvider() });
  return { items: res?.items || [], provider: res?.provider || aiProvider() };
}

/** Activities with MET and minutes; `weightKg` is the user's weight on that day. → items */
export async function analyzeActivity(text, weightKg) {
  const res = await callFunction('ai-food-analysis', { mode: 'activity', text, weight_kg: weightKg, provider: aiProvider() });
  return res?.items || [];
}

/** mode: 'chat' | 'day_review' | 'meal_plan' → { reply, foods, provider } */
export async function coach(mode, date, messages = []) {
  return callFunction('ai-chat', { mode, date, messages, provider: aiProvider() });
}
