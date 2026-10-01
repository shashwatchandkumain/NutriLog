// AI features — every call goes to a Supabase Edge Function. The browser never holds a
// Gemini or Claude key; it sends the request with the user's session and gets results back.
import { callFunction } from './supabase.js';

export async function analyzeFoodText(text) {
  const { items } = await callFunction('ai-food-analysis', { mode: 'text', text });
  return items || [];
}

export async function analyzeFoodImage(image, note = '') {
  const { items } = await callFunction('ai-food-analysis', { mode: 'image', image: { mediaType: image.mediaType, base64: image.base64 }, text: note });
  return items || [];
}

export async function analyzeActivity(text) {
  const { items } = await callFunction('ai-food-analysis', { mode: 'activity', text });
  return items || [];
}

/** mode: 'chat' | 'day_review' | 'meal_plan' → { reply, foods } */
export async function coach(mode, date, messages = []) {
  return callFunction('ai-chat', { mode, date, messages });
}
