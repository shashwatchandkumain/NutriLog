import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, foodKey, recentFoods, searchFoods, scaleFood, withFavorites } from '../../js/lib/food-library.js';
import { formatVolume } from '../../js/lib/utils.js';

const items = [
  { food_name: 'Dal tadka', quantity: 150, unit: 'g', grams: 150, calories: 193.5, protein: 9, carbs: 22.5, fat: 7.5, fiber: 6, meal_date: '2026-09-29', created_at: '2026-09-29T08:00:00Z' },
  { food_name: 'Masala Chai', quantity: 1, unit: 'cup', grams: 150, calories: 67.5, protein: 1.8, carbs: 10.5, fat: 1.95, fiber: 0, meal_date: '2026-09-30', created_at: '2026-09-30T04:00:00Z' },
  { food_name: 'dal  tadka', quantity: 200, unit: 'g', grams: 200, calories: 258, protein: 12, carbs: 30, fat: 10, fiber: 8, meal_date: '2026-10-01', created_at: '2026-10-01T08:00:00Z' },
  { food_name: 'Jeera rice', quantity: 158, unit: 'g', grams: 158, calories: 238.58, protein: 4.74, carbs: 44.24, fat: 4.74, fiber: 1.58, meal_date: '2026-09-28', created_at: '2026-09-28T08:00:00Z' },
];

test('recent foods: newest first, one per name + unit, latest portion kept', () => {
  const r = recentFoods(items);
  assert.deepEqual(r.map((f) => f.food_name), ['dal  tadka', 'Masala Chai', 'Jeera rice']);
  assert.equal(r[0].quantity, 200, 'the most recent portion of dal tadka');
  assert.equal(r[0].timesLogged, 2);
  assert.equal(foodKey('Dal  Tadka', 'G'), foodKey('dal tadka', 'g'));
  assert.equal(normalizeName('Café — Latte!'), 'cafe latte');
});

test('search matches every word and ranks name starts first', () => {
  const foods = recentFoods(items);
  assert.deepEqual(searchFoods(foods, 'rice').map((f) => f.food_name), ['Jeera rice']);
  assert.deepEqual(searchFoods(foods, 'TADKA dal').map((f) => f.food_name), ['dal  tadka']);
  assert.deepEqual(searchFoods(foods, 'chai').map((f) => f.food_name), ['Masala Chai']);
  assert.deepEqual(searchFoods(foods, 'ma').map((f) => f.food_name), ['Masala Chai'], 'starts-with beats contains');
  assert.equal(searchFoods(foods, 'pizza').length, 0);
  assert.equal(searchFoods(foods, '').length, 3);
});

test('portions scale linearly from what was logged', () => {
  const [dal] = recentFoods(items);
  const half = scaleFood(dal, 100);
  assert.deepEqual([half.calories, half.protein, half.grams], [129, 6, 100]);
  const chai = recentFoods(items)[1];
  const two = scaleFood(chai, 2);
  assert.deepEqual([two.calories, two.grams, two.unit], [135, 300, 'cup']);
  assert.equal(scaleFood(dal, 0).calories, 0);
});

test('favorites come first and are not repeated in recents', () => {
  const favs = [{ id: 'f1', food_name: 'Jeera rice', quantity: 158, unit: 'g', grams: 158, calories: 238.58, protein: 4.74, carbs: 44.24, fat: 4.74, fiber: 1.58, created_at: '2026-10-01T00:00:00Z' }];
  const list = withFavorites(recentFoods(items), favs);
  assert.deepEqual(list.map((f) => [f.food_name, !!f.favorite]), [['Jeera rice', true], ['dal  tadka', false], ['Masala Chai', false]]);
  assert.equal(list[0].favoriteId, 'f1');
});

test('water amounts format as ml or litres', () => {
  assert.equal(formatVolume(750), '750 ml');
  assert.equal(formatVolume(1500), '1.5 L');
  assert.equal(formatVolume(2000), '2 L');
  assert.equal(formatVolume(-5), '0 ml');
});
