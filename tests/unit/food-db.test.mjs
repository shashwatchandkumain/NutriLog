import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FOODS } from '../../food_db.js';
import { checkConsistency } from '../../js/lib/nutrition.js';

const byName = (n) => FOODS.find((f) => f.name === n);

test('every food follows the data model', () => {
  const ids = new Set(), names = new Set();
  for (const f of FOODS) {
    for (const k of ['id', 'name', 'category']) assert.equal(typeof f[k], 'string', `${f.name}: ${k}`);
    assert.equal(f.servingSize, 100, f.name);
    assert.ok(['g', 'ml'].includes(f.servingUnit), f.name);
    for (const k of ['calories', 'protein', 'carbs', 'fat', 'fiber']) {
      assert.ok(Number.isFinite(f[k]) && f[k] >= 0, `${f.name}: ${k}=${f[k]}`);
    }
    assert.ok(f.calories <= 902, `${f.name}: ${f.calories} kcal/100g is impossible`);
    assert.ok(f.protein + f.carbs + f.fat <= 100.5, `${f.name}: macros exceed 100 g`);
    for (const p of f.portions) assert.ok(p.grams > 0 && p.label, `${f.name}: bad portion`);
    assert.ok(!ids.has(f.id), `duplicate id ${f.id}`); ids.add(f.id);
    assert.ok(!names.has(f.name.toLowerCase()), `duplicate name ${f.name}`); names.add(f.name.toLowerCase());
  }
  assert.ok(FOODS.length > 1000);
});

test('calories agree with macros for every food (except spice blends)', () => {
  const bad = FOODS.filter((f) => !/spice|masala|powder|phoran/i.test(f.name))
    .filter((f) => Math.abs((f.protein * 4 + f.carbs * 4 + f.fat * 9) - f.calories) > Math.max(15, 0.25 * f.calories));
  assert.deepEqual(bad.map((f) => f.name), []);
});

test('frying-oil inflation is gone', () => {
  const fatty = /mayonnaise|dressing|tartare|baghar|tadka|icing|butter|ghee|walnut|almond|coconut chutney|oil|peanut|cashew|chia|flax|chips|sev|mathri|namak paras|papdi|murukku|bhujia|chakli|nimki/i;
  const inflated = FOODS.filter((f) => f.fat >= 30 && f.fat / (f.protein + f.carbs + f.fat + f.fiber) >= 0.57 && !fatty.test(f.name));
  assert.deepEqual(inflated.map((f) => `${f.name} (${f.fat} g fat)`), []);
  assert.ok(byName('Poori').calories < 400);
  assert.ok(byName('Dum aloo').calories < 200);
  assert.ok(byName('Boondi raita').calories < 250);
});

test('soups no longer carry impossible macros', () => {
  const egg = byName('Egg drop soup');
  assert.ok(checkConsistency(egg).ok);
  assert.ok(egg.protein < 5);
});

test('staples exist with reference values and household portions', () => {
  const expect = {
    'Egg, boiled (whole)': [155, 12.6], 'Banana': [89, 1.1], 'Rice, white, cooked (boiled)': [130, 2.7],
    'Roti / Chapati (whole wheat, no ghee)': [280, 9], 'Chicken breast, cooked (skinless)': [165, 31],
    'Paneer (full fat)': [272, 18.3], 'Milk, toned (3% fat)': [58, 3.1], 'Dal, cooked (plain, medium consistency)': [104, 6],
  };
  for (const [name, [kcal, prot]] of Object.entries(expect)) {
    const f = byName(name);
    assert.ok(f, `missing ${name}`);
    assert.equal(f.calories, kcal); assert.equal(f.protein, prot);
    assert.equal(f.source, 'core');
    assert.ok(f.portions.length > 0, `${name} needs portions`);
  }
  assert.equal(byName('Milk, toned (3% fat)').servingUnit, 'ml');
  assert.equal(byName('Boiled egg (Ubla anda)'), undefined, 'the 45 kcal boiled egg entry must be gone');
});
