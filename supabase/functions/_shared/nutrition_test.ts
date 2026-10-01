// deno test supabase/functions/_shared/
import { assertEquals, assert } from 'jsr:@std/assert@1';
import { normalizeFoods, normalizeActivities } from './nutrition.ts';
import { parseJsonLoose } from './ai.ts';

Deno.test('totals are computed from per-100 g values, not trusted from the model', () => {
  const [item] = normalizeFoods({ items: [{ food_name: 'Chicken breast', portion_description: '1 piece', grams: 150, confidence: 'high',
    per_100g: { calories: 165, protein: 31, carbs: 0, fat: 3.6, fiber: 0 }, calories: 9999 }] });
  assertEquals(item.calories, 247.5);
  assertEquals(item.protein, 46.5);
  assertEquals(item.warnings, []);
});

Deno.test('inconsistent calories are matched to macros and flagged', () => {
  const [item] = normalizeFoods({ items: [{ food_name: 'Soup', portion_description: 'bowl', grams: 200, confidence: 'medium',
    per_100g: { calories: 27, protein: 12.9, carbs: 1.1, fat: 13.5, fiber: 0.8 } }] });
  assert(item.warnings.includes('calories_adjusted_to_macros'));
  assertEquals(item.per_100g.calories, Math.round(12.9 * 4 + 1.1 * 4 + 13.5 * 9));
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

Deno.test('activities use net MET calories', () => {
  const [a] = normalizeActivities({ items: [{ activity_name: 'Running', duration_min: 30, met: 9.8 }] }, 80) as { calories_burned: number }[];
  assertEquals(a.calories_burned, Math.round(8.8 * 80 * 0.5));
});

Deno.test('JSON extraction tolerates fences and prose', () => {
  assertEquals(parseJsonLoose('```json\n{"items":[]}\n```'), { items: [] });
  assertEquals(parseJsonLoose('Sure! {"a":{"b":"}"}} thanks'), { a: { b: '}' } });
});
