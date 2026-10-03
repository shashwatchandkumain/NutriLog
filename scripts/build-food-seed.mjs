// Builds the starting Global Food Database from scripts/food-data/global-foods.mjs:
//   supabase/migrations/006_global_foods_seed.sql   (what production runs)
//   scripts/food-data/global-foods.json             (the same rows, for the browser tests' mock)
//
//   USDA_SR_JSON=/path/FoodData_Central_sr_legacy_food_json_2018-04.json npm run build:food-seed
//
// The USDA file (SR Legacy, public domain) is downloaded from
// https://fdc.nal.usda.gov/download-datasets and is not committed. Calories are always
// 4 × protein + 4 × carbs + 9 × fat (+ 7 × alcohol) — the rule NutriLog uses everywhere.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { GLOBAL_FOODS } from './food-data/global-foods.mjs';
import { nameKey } from '../js/lib/food-key.js';

const ROOT = new URL('../', import.meta.url);
const SR_PATH = process.env.USDA_SR_JSON;
if (!SR_PATH) { console.error('Set USDA_SR_JSON to the SR Legacy JSON file (see the header of this script).'); process.exit(1); }

// ── Sources ─────────────────────────────────────────────────────────────
const refSrc = readFileSync(new URL('supabase/functions/_shared/reference-foods.ts', ROOT), 'utf8');
const REF = new Map();
for (const m of refSrc.matchAll(/^\s*\["(.+?)", "(g|ml)", ([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+), "(.*)"\],$/gm)) {
  REF.set(m[1], { unit: m[2], protein: +m[4], carbs: +m[5], fat: +m[6], fiber: +m[7], portions: m[8] });
}
const SR = new Map(JSON.parse(readFileSync(SR_PATH, 'utf8')).SRLegacyFoods.map((f) => [f.fdcId, f]));

// USDA nutrient numbers → our columns (per 100 g).
const MACRO = { protein: '203', fat: '204', carbs: '205', fiber: '291', alcohol: '221', sugar: '269', saturated_fat: '606', trans_fat: '605', sodium_mg: '307', cholesterol_mg: '601' };
const MICRO = {
  vitamin_a_ug: '320', vitamin_b1_mg: '404', vitamin_b2_mg: '405', vitamin_b3_mg: '406', vitamin_b5_mg: '410', vitamin_b6_mg: '415',
  vitamin_b9_ug: '435', vitamin_b12_ug: '418', vitamin_c_mg: '401', vitamin_d_ug: '328', vitamin_e_mg: '323', vitamin_k_ug: '430',
  calcium_mg: '301', iron_mg: '303', magnesium_mg: '304', phosphorus_mg: '305', potassium_mg: '306', zinc_mg: '309',
  copper_mg: '312', manganese_mg: '315', selenium_ug: '317',
};
const r2 = (v) => Math.round(v * 100) / 100;

/** Deterministic uuid for a seed row, so re-running the migration never duplicates anything. */
const seedId = (kind, name) => {
  const h = createHash('sha256').update(`nutrilog-seed:${kind}:${name}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

function fromUsda(id) {
  const f = SR.get(id);
  if (!f) throw new Error(`USDA ${id} not found`);
  const by = new Map(f.foodNutrients.map((n) => [n.nutrient.number, n.amount]));
  const val = (num) => (by.has(num) ? Number(by.get(num)) : null);
  const n = Object.fromEntries(Object.entries(MACRO).map(([k, num]) => [k, val(num)]));
  const micros = {};
  for (const [k, num] of Object.entries(MICRO)) if (val(num) != null) micros[k] = Math.round(val(num) * 1000) / 1000;
  return {
    n, micros, portions: (f.foodPortions || []).map((p) => [`${p.amount} ${p.modifier || p.portionDescription || ''}`.trim(), p.gramWeight]),
    source: `USDA FoodData Central, SR Legacy: ${f.description}`, source_id: `fdc:${id}`,
    source_url: `https://fdc.nal.usda.gov/food-details/${id}/nutrients`, source_type: 'verified_source',
  };
}

function fromRef(name) {
  const r = REF.get(name);
  if (!r) throw new Error(`reference row "${name}" not found`);
  const portions = r.portions.split(';').map((s) => /^\s*(.+?)\s*=\s*([\d.]+)\s*(g|ml)\s*$/.exec(s)).filter(Boolean).map((m) => [m[1], Number(m[2])]);
  return {
    n: { protein: r.protein, carbs: r.carbs, fat: r.fat, fiber: r.fiber, alcohol: 0, sugar: null, saturated_fat: null, trans_fat: null, sodium_mg: null, cholesterol_mg: null },
    micros: {}, portions, unit: r.unit,
    source: `NutriLog reference table (IFCT 2017 / USDA FoodData Central / Indian labels): ${name}`, source_id: `ref:${name}`,
    source_url: null, source_type: 'global_manual',
  };
}

// ── Build rows ──────────────────────────────────────────────────────────
const foods = [];
const keys = new Map(); // key → food name (to catch clashes between foods and aliases)
const claim = (key, owner) => {
  if (!key) throw new Error(`empty key for ${owner}`);
  const prev = keys.get(key);
  if (prev && prev !== owner) throw new Error(`"${key}" is used by both ${prev} and ${owner}`);
  keys.set(key, owner);
};
for (const def of GLOBAL_FOODS) {
  const src = def.usda ? fromUsda(def.usda) : fromRef(def.ref);
  const { n } = src;
  if ([n.protein, n.carbs, n.fat].some((v) => v == null)) throw new Error(`${def.name}: missing macros`);
  const calories = r2(4 * n.protein + 4 * n.carbs + 9 * n.fat + 7 * (n.alcohol || 0));
  const servings = (def.servings || src.portions).slice(0, 6).map(([label, grams], i) => ({ id: seedId('serving', `${def.name}|${label}`), label, grams: r2(grams), is_default: i === 0, sort_order: i }));
  const key = nameKey(def.name);
  claim(key, def.name);
  const aliases = [...new Set(def.aliases.map((a) => a.trim()).filter(Boolean))]
    .filter((a) => nameKey(a) !== key)
    .map((a) => { claim(nameKey(a), def.name); return { alias: a, alias_key: nameKey(a) }; });
  foods.push({
    id: seedId('food', def.name), name: def.name, name_key: key, category: def.category, preparation: def.prep || null,
    base_unit: def.unit || src.unit || 'g',
    calories, protein: r2(n.protein), carbs: r2(n.carbs), fat: r2(n.fat), fiber: r2(Math.min(n.fiber ?? 0, n.carbs)),
    sugar: n.sugar == null ? null : r2(n.sugar), saturated_fat: n.saturated_fat == null ? null : r2(n.saturated_fat),
    trans_fat: n.trans_fat == null ? null : r2(n.trans_fat), sodium_mg: n.sodium_mg == null ? null : r2(n.sodium_mg),
    cholesterol_mg: n.cholesterol_mg == null ? null : r2(n.cholesterol_mg), micros: src.micros,
    source_type: src.source_type, source: src.source, source_id: src.source_id, source_url: src.source_url,
    servings, aliases,
  });
}

// ── Write ───────────────────────────────────────────────────────────────
const q = (v) => (v == null ? 'null' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const lines = [];
lines.push(`-- NutriLog — the starting Global Food Database (${foods.length} foods).`);
lines.push('-- GENERATED by scripts/build-food-seed.mjs from scripts/food-data/global-foods.mjs — do not edit by hand.');
lines.push('-- Sources: USDA FoodData Central SR Legacy (public domain) and NutriLog\'s reference table');
lines.push('-- (IFCT 2017 / USDA / Indian labels). Unknown micronutrients are absent (null), never zero.');
lines.push('-- Safe to re-run: every row has a fixed id and existing rows are left alone.');
lines.push('');
for (const f of foods) {
  lines.push(`insert into public.foods (id, name, name_key, category, preparation, base_unit, calories, protein, carbs, fat, fiber, sugar, saturated_fat, trans_fat, sodium_mg, cholesterol_mg, micros, source_type, source, source_id, source_url, confidence, status, last_verified_at)
  values (${[f.id, f.name, f.name_key, f.category, f.preparation, f.base_unit, f.calories, f.protein, f.carbs, f.fat, f.fiber, f.sugar, f.saturated_fat, f.trans_fat, f.sodium_mg, f.cholesterol_mg].map(q).join(', ')}, ${q(JSON.stringify(f.micros))}::jsonb, ${[f.source_type, f.source, f.source_id, f.source_url].map(q).join(', ')}, 1, 'verified', now())
  on conflict do nothing;`);
  for (const s of f.servings) lines.push(`insert into public.food_servings (id, food_id, label, grams, is_default, sort_order) values (${[s.id, f.id, s.label, s.grams].map(q).join(', ')}, ${s.is_default}, ${s.sort_order}) on conflict do nothing;`);
  for (const a of f.aliases) lines.push(`insert into public.food_aliases (alias, alias_key, food_id, status) values (${[a.alias, a.alias_key, f.id].map(q).join(', ')}, 'verified') on conflict do nothing;`);
  lines.push('');
}
writeFileSync(new URL('supabase/migrations/006_global_foods_seed.sql', ROOT), `${lines.join('\n')}\n`);
writeFileSync(new URL('scripts/food-data/global-foods.json', ROOT), `${JSON.stringify(foods, null, 1)}\n`);
console.log(`✓ ${foods.length} foods, ${foods.reduce((s, f) => s + f.aliases.length, 0)} aliases, ${foods.reduce((s, f) => s + f.servings.length, 0)} servings · ${foods.filter((f) => f.source_type === 'verified_source').length} from USDA with micronutrients`);
