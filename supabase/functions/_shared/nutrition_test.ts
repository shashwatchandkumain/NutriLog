// deno test supabase/functions/_shared/
import { assertEquals, assert } from 'jsr:@std/assert@1';
import { normalizeFoods, normalizeActivities, energyFromMacros, FOOD_RULES } from './nutrition.ts';
import { REFERENCE_COUNT } from './reference-foods.ts';
import { parseJsonLoose } from './ai.ts';

Deno.test('totals are computed from per-100 g macros, not trusted from the model', () => {
  const [item] = normalizeFoods({ items: [{ food_name: 'Chicken breast', portion_description: '1 piece', grams: 150, confidence: 'high',
    per_100g: { calories: 165, protein: 31, carbs: 0, fat: 3.6, fiber: 0, alcohol: 0 }, calories: 9999 }] });
  assertEquals(item.per_100g.calories, 156.4);           // 31·4 + 3.6·9
  assertEquals(item.calories, 234.6);
  assertEquals(item.protein, 46.5);
});

Deno.test('energy always follows the macros, so a low or high calorie guess cannot leak through', () => {
  const low = normalizeFoods({ items: [{ food_name: 'Dal', grams: 150, per_100g: { calories: 80, protein: 6, carbs: 16, fat: 1.8, fiber: 4 } }] })[0];
  const high = normalizeFoods({ items: [{ food_name: 'Dal', grams: 150, per_100g: { calories: 140, protein: 6, carbs: 16, fat: 1.8, fiber: 4 } }] })[0];
  assertEquals(low.calories, high.calories);
  assertEquals(low.per_100g.calories, Math.round(energyFromMacros(6, 16, 1.8) * 100) / 100);
  // Alcohol counts 7 kcal/g; fiber can never exceed total carbohydrate.
  const beer = normalizeFoods({ items: [{ food_name: 'Beer', grams: 330, per_100g: { calories: 43, protein: 0.5, carbs: 3.6, fat: 0, fiber: 9, alcohol: 3.9 } }] })[0];
  assertEquals(beer.per_100g.calories, Math.round((0.5 * 4 + 3.6 * 4 + 3.9 * 7) * 100) / 100);
  assertEquals(beer.per_100g.fiber, 3.6);
});

Deno.test('impossible or malformed items are dropped; values are clamped', () => {
  const out = normalizeFoods({ items: [
    { food_name: 'Impossible', grams: 100, per_100g: { calories: 500, protein: 60, carbs: 60, fat: 10, fiber: 0 } },
    { food_name: '', grams: 100, per_100g: { calories: 100, protein: 1, carbs: 1, fat: 1, fiber: 0 } },
    { food_name: 'No grams', per_100g: { calories: 100, protein: 1, carbs: 1, fat: 1, fiber: 0 } },
    { food_name: 'Huge', grams: 99999, per_100g: { calories: 50, protein: 1, carbs: 10, fat: 0.5, fiber: 1 }, confidence: 'weird' },
  ] });
  assertEquals(out.map((x) => x.food_name), ['Huge']);
  assertEquals(out[0].grams, 5000);
  assertEquals(out[0].confidence, 'medium');
  assertEquals(normalizeFoods(null), []);
});

Deno.test('activities use net MET calories with the weight on that day, unrounded', () => {
  const [a] = normalizeActivities({ items: [{ activity_name: 'Treadmill walk', duration_min: 30, met: 3.857 }] }, 92) as { met: number; calories_burned: number }[];
  assertEquals(a.met, 3.86);
  assertEquals(a.calories_burned, Math.round(2.86 * 92 * 0.5 * 100) / 100);
});

Deno.test('both models share the same rules and reference table', () => {
  assert(REFERENCE_COUNT >= 100);
  assert(FOOD_RULES.includes('Roti / Chapati'));
  assert(FOOD_RULES.includes('MOST LIKELY'));
});

Deno.test('JSON extraction tolerates fences and prose', () => {
  assertEquals(parseJsonLoose('```json\n{"items":[]}\n```'), { items: [] });
  assertEquals(parseJsonLoose('Sure! {"a":{"b":"}"}} thanks'), { a: { b: '}' } });
});

Deno.test('CORS is restricted to the NutriLog site by default (never *)', async () => {
  const { corsHeaders, ALLOWED_ORIGINS } = await import('./http.ts');
  assert(!ALLOWED_ORIGINS.includes('*'));
  const ok = corsHeaders(new Request('https://x.supabase.co/functions/v1/ai-chat', { headers: { Origin: ALLOWED_ORIGINS[0] } }));
  assertEquals(ok['Access-Control-Allow-Origin'], ALLOWED_ORIGINS[0]);
  const evil = corsHeaders(new Request('https://x.supabase.co/functions/v1/ai-chat', { headers: { Origin: 'https://evil.example' } }));
  assertEquals(evil['Access-Control-Allow-Origin'], ALLOWED_ORIGINS[0]);
});
