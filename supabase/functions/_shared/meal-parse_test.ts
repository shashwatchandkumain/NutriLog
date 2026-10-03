import { assertEquals } from 'jsr:@std/assert@1';
import { normalizeEstimates, validateParsed } from './meal-parse.ts';

const item = (o: Record<string, unknown>) => ({ quantity: null, unit: null, amount_vague: false, preparation: null, modifier_of: null, ...o });

Deno.test('parse: foods the user never mentioned are dropped (no invented white bread)', () => {
  const text = 'I ate one roti with three boiled eggs and a half-fried egg with a little butter';
  const out = validateParsed({ items: [
    item({ text_span: 'one roti', food_name: 'roti', quantity: 1 }),
    item({ text_span: 'three boiled eggs', food_name: 'boiled egg', quantity: 3, preparation: 'boiled' }),
    item({ text_span: 'a half-fried egg', food_name: 'half fried egg', quantity: 1, preparation: 'half-fried' }),
    item({ text_span: 'a little butter', food_name: 'butter', quantity: 5, amount_vague: true, modifier_of: 3 }),
    item({ text_span: 'white bread', food_name: 'white bread', quantity: 2 }),
  ] }, text);
  assertEquals(out.map((i) => i.food_name), ['roti', 'boiled egg', 'half fried egg', 'butter']);
  assertEquals(out[2].preparation, 'half-fried', 'preparation kept');
  assertEquals([out[3].quantity, out[3].amount_vague, out[3].modifier_of], [null, true, null], 'vague amount is not guessed; link to a dropped/invalid item cleared');
});

Deno.test('parse: modifier links follow the kept items', () => {
  const out = validateParsed({ items: [
    item({ text_span: 'toast', food_name: 'toast' }),                       // not in the text → dropped
    item({ text_span: 'half-fried egg', food_name: 'half fried egg' }),
    item({ text_span: 'little butter', food_name: 'butter', amount_vague: true, modifier_of: 1 }),
  ] }, 'half-fried egg with little butter');
  assertEquals(out.map((i) => [i.food_name, i.modifier_of]), [['half fried egg', null], ['butter', 0]]);
});

Deno.test('estimate: one result per requested food, energy from macros, impossible values dropped', () => {
  const out = normalizeEstimates({ items: [
    { index: 0, food_name: 'Peanut chutney', category: 'chutney', grams: 10, per_100g: { protein: 9, carbs: 12, fat: 20, fiber: 4, alcohol: 0, sugar: null, saturated_fat: 3, sodium_mg: 400, cholesterol_mg: null }, servings: [{ label: '1 tbsp', grams: 15 }], confidence: 'medium' },
    { index: 0, food_name: 'duplicate', category: '', grams: 10, per_100g: { protein: 1, carbs: 1, fat: 1, fiber: 0, alcohol: 0 }, servings: [], confidence: 'high' },
    { index: 1, food_name: 'Impossible', category: '', grams: 10, per_100g: { protein: 90, carbs: 90, fat: 1, fiber: 0, alcohol: 0 }, servings: [], confidence: 'high' },
    { index: 7, food_name: 'Not requested', category: '', grams: 10, per_100g: { protein: 1, carbs: 1, fat: 1, fiber: 0, alcohol: 0 }, servings: [], confidence: 'high' },
  ] }, 2);
  assertEquals(out.length, 1);
  assertEquals(out[0].per_100g.calories, 264);
  assertEquals(out[0].per_100g.sugar, null, 'unknown stays unknown');
});
