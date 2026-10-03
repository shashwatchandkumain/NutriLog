// Database-first logging, on the device: the meal parser, portions from stored servings,
// nutrition maths and safe matching.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMealText, parseChunk } from '../../js/lib/meal-parser.js';
import { nameKey } from '../../js/lib/food-key.js';
import { portionFor, nutritionFor, isSafeFuzzyMatch, amountText, mergeAmounts, sameFood, servingForUnit } from '../../js/lib/food-resolve.js';

const FOODS = JSON.parse(readFileSync(new URL('../../scripts/food-data/global-foods.json', import.meta.url), 'utf8'));
const food = (name) => FOODS.find((f) => f.name === name);
const view = (r) => r.items.map((i) => [i.quantity, i.unit, i.name, i.vague, i.modifierOf]);

test('meal parser: the spec examples, words for numbers, Hinglish and vague amounts', () => {
  let r = parseMealText('I ate 1 roti with 10g butter and 4 boiled eggs.');
  assert.equal(r.complete, true);
  assert.deepEqual(view(r), [[1, null, 'roti', false, null], [10, 'g', 'butter', false, 0], [4, null, 'boiled eggs', false, null]]);

  r = parseMealText('I ate one roti with three boiled eggs and a half-fried egg with a little butter');
  assert.deepEqual(view(r), [[1, null, 'roti', false, null], [3, null, 'boiled eggs', false, 0], [1, null, 'half-fried egg', false, null], [null, null, 'butter', true, 2]]);
  assert.ok(!r.items.some((i) => /bread/.test(i.name)), 'nothing invented');

  assert.deepEqual(view(parseMealText('I had one and a half bananas')), [[1.5, null, 'bananas', false, null]]);
  assert.deepEqual(view(parseMealText('200 grams chicken and 150 grams rice')), [[200, 'g', 'chicken', false, null], [150, 'g', 'rice', false, null]]);
  assert.deepEqual(view(parseMealText('dedh roti aur dal')), [[1.5, null, 'roti', false, null], [null, null, 'dal', false, null]]);
  assert.deepEqual(view(parseMealText('a katori dal tadka, rice 200g, 1/2 apple')),
    [[1, 'katori', 'dal tadka', false, null], [200, 'g', 'rice', false, null], [0.5, null, 'apple', false, null]]);
  assert.deepEqual(parseChunk('2 cups of milk'), { name: 'milk', quantity: 2, unit: 'cup', vague: false });
  assert.deepEqual(parseChunk('1 1/2 cups milk'), parseChunk('1.5 cups milk'));
  assert.equal(parseMealText('chicken biryani from the restaurant near my office with extra raita').complete, false, 'free-form text goes to AI parsing');
  assert.equal(parseMealText('').complete, false);
});

test('portions come from the stored servings — eggs, rotis, katoris, grams, fractions', () => {
  const egg = food('Boiled egg');
  assert.deepEqual(portionFor(egg, { quantity: 4 }), { grams: 200, quantity: 4, servingLabel: '1 large egg', needsAmount: false, note: null });
  assert.equal(portionFor(egg, { quantity: 1.5 }).grams, 75);
  assert.equal(portionFor(egg, { quantity: 300, unit: 'g' }).grams, 300);
  assert.equal(portionFor(food('Roti'), { quantity: 1.5 }).grams, 60);
  assert.equal(portionFor(food('Dal tadka'), { quantity: 1, unit: 'katori' }).grams, 150);
  assert.equal(servingForUnit(food('Dal tadka'), 'bowl').label, '1 katori (bowl)');
  assert.equal(portionFor(food('Milk, whole'), { quantity: 0.5, unit: 'l' }).grams, 500);
  assert.equal(portionFor(food('Butter'), { vague: true }).needsAmount, true, 'a little butter → the user chooses');
  assert.equal(amountText(portionFor(egg, { quantity: 4 })), '4 × 1 large egg (200 g)');
  assert.equal(amountText({ quantity: 10, servingLabel: 'g', grams: 10 }), '10 g');
});

test('nutrition is scaled locally, including vitamins and minerals; unknown stays unknown', () => {
  const egg = food('Boiled egg');
  const n = nutritionFor(egg, 200);
  assert.equal(Math.round(n.calories * 100) / 100, 300.56);
  assert.equal(Math.round(n.protein * 10) / 10, 25.2);
  assert.equal(Math.round(n.micros.iron_mg * 100) / 100, 2.38);
  assert.equal(n.trans_fat, null);
  const roti = nutritionFor(food('Roti'), 40);
  assert.deepEqual(roti.micros, {}, 'no invented micronutrients for reference-table foods');
  // "1 roti with 10g butter and 4 boiled eggs", all from the database:
  const total = [nutritionFor(food('Roti'), 40), nutritionFor(food('Butter'), 10), n].reduce((s, x) => s + x.calories, 0);
  assert.equal(Math.round(total), Math.round(280.1 * 0.4 + food('Butter').calories * 0.1 + 300.56));
});

test('fuzzy matches are used only when clearly the same food', () => {
  assert.equal(isSafeFuzzyMatch('chapatii', nameKey('chapati')), true, 'one typo');
  assert.equal(isSafeFuzzyMatch('half fried egg', nameKey('Fried egg')), false, 'different preparation');
  assert.equal(isSafeFuzzyMatch('egg', nameKey('Egg white')), false, 'food has an extra word');
  assert.equal(isSafeFuzzyMatch('boild egg', nameKey('Boiled egg')), true);
  assert.equal(isSafeFuzzyMatch('rice', nameKey('Rice, brown, cooked')), false);
});

test('adding more of the same food merges amounts', () => {
  const egg = food('Boiled egg');
  const three = { food: egg, ...portionFor(egg, { quantity: 3 }) };
  const one = { food: egg, ...portionFor(egg, { quantity: 1 }) };
  assert.deepEqual([mergeAmounts(three, one).quantity, mergeAmounts(three, one).grams], [4, 200]);
  const grams = { food: egg, ...portionFor(egg, { quantity: 30, unit: 'g' }) };
  assert.deepEqual([mergeAmounts(three, grams).servingLabel, mergeAmounts(three, grams).grams], ['g', 180]);
  assert.equal(sameFood({ food: egg }, { food: food('Fried egg') }), false);
  assert.equal(sameFood({ food: egg }, { food: egg }), true);
});

test('vitamins & minerals add up across the foods that carry them', async () => {
  const { dayMicros } = await import('../../js/lib/micros.js');
  const egg = food('Boiled egg');
  const d = dayMicros([{ micros: nutritionFor(egg, 100).micros }, { micros: nutritionFor(egg, 50).micros }, { micros: null }, {}]);
  assert.deepEqual([d.withData, d.foods], [2, 4]);
  const iron = d.rows.find((r) => r.key === 'iron_mg');
  assert.equal(Math.round(iron.amount * 1000) / 1000, 1.785);
  assert.equal(Math.round(iron.pct), 10);
  assert.equal(d.rows.find((r) => r.key === 'vitamin_c_mg').amount, 0, 'known zero stays zero');
});
