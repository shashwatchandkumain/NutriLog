import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FOODS } from '../../food_db.js';
import { buildIndex, searchFoods, normalize, phonetic, editDistance } from '../../js/lib/food-search.js';

const index = buildIndex(FOODS);
const first = (q) => searchFoods(index, q, 5)[0]?.name;

test('spec examples return the staple first', () => {
  assert.match(first('roti'), /^Roti \/ Chapati/);
  assert.match(first('chapati'), /^Roti \/ Chapati/);
  assert.match(first('chicken breast'), /^Chicken breast/);
  assert.equal(first('paneer'), 'Paneer (full fat)');
  assert.match(first('dal'), /^Dal/);
  assert.match(first('rice'), /^Rice, white/);
  assert.equal(first('egg'), 'Egg, boiled (whole)');
  assert.equal(first('banana'), 'Banana');
});

test('Hindi names, synonyms and spelling variations', () => {
  assert.equal(first('kela'), 'Banana');
  assert.equal(first('anda'), 'Egg, boiled (whole)');
  assert.match(first('dahi'), /^Curd/);
  assert.match(first('phulka'), /^Roti/);
  assert.equal(first('panner'), 'Paneer (full fat)');
  assert.match(first('chiken'), /^Chicken/);
  assert.match(first('daal'), /^Dal/);
  assert.match(first('idly'), /^Idli/);
  assert.match(first('wada pav'), /^Vada pav/);
  assert.match(first('biriyani'), /biryani/i);
  assert.match(first('aloo paratha'), /Potato parantha/);
});

test('partial names and multi-word queries', () => {
  assert.ok(searchFoods(index, 'butt chick', 5).some((f) => f.name === 'Butter chicken'));
  assert.ok(searchFoods(index, 'palak pan', 5).some((f) => /Spinach paneer|Palak paneer/.test(f.name)));
  assert.deepEqual(searchFoods(index, 'x', 5), []);
  assert.deepEqual(searchFoods(index, 'zzzzqqq', 5), []);
});

test('normalization helpers', () => {
  assert.equal(normalize('  Aloo-Gobhi (Dry)! '), 'aloo gobhi dry');
  assert.equal(phonetic('daal'), 'dal');
  assert.equal(phonetic('wada'), 'vada');
  assert.equal(phonetic('bhindi'), 'bindi');
  assert.equal(editDistance('paneer', 'panner'), 1);
  assert.equal(editDistance('kitten', 'sitting', 5), 3);
});
