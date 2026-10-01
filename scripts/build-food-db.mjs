#!/usr/bin/env node
// Builds food_db.js from:
//   scripts/food-data/core-foods.mjs     curated staples (reference values + household portions)
//   scripts/food-data/indb-recipes.json  the original Indian recipe list (per 100 g) shipped by NutriLog
//
// The original recipe list has two systematic data errors that this script corrects,
// plus a handful of individual entries that are clearly wrong. Every change is written to
// scripts/food-data/CORRECTIONS.md so the data stays auditable.
//
// Usage: node scripts/build-food-db.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_FOODS } from './food-data/core-foods.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const raw = JSON.parse(readFileSync(join(here, 'food-data/indb-recipes.json'), 'utf8'));

const r1 = (v) => Math.round(v * 10) / 10;
const atwater = (f) => f.protein * 4 + f.carbs * 4 + f.fat * 9;

// ── 1. Frying-oil inflation ──────────────────────────────────────────────
// For deep-fried recipes the source counted the entire frying-oil vat as part of the dish
// (e.g. Poori: 738 kcal and 77.6 g fat per 100 g, with only 8 g carbohydrate).
// Fix: remove x grams of pure oil so that fat makes up TARGET_FAT_SHARE of the macro mass,
// then re-express every nutrient per 100 g of the remaining food. This keeps the recipe's own
// protein : carbohydrate : fiber ratios and only removes oil that was never eaten.
const TARGET_FAT_SHARE = 0.30;
const OIL_FLAG_MIN_FAT = 30;      // g per 100 g
const OIL_FLAG_MIN_SHARE = 0.57;  // fat / (protein + carbs + fat + fiber)
// Foods that genuinely are mostly fat — never "de-oiled".
const INTRINSICALLY_FATTY = /mayonnaise|dressing|tartare|baghar|tadka|icing|butter|ghee|walnut|almond|coconut chutney/i;

// Dry fried snacks (chips, sev, mathri...) also lost their cooking water, which the source kept.
// For these the result is expressed as a dry product: ~95 g of macros per 100 g, 35 g of it fat.
const DRY_SNACK = /chips|\bsev\b|mathri|namak paras|papdi|murukku|bhujia|chakli|nimki/i;
const DRY_SNACK_FAT = 35;
const DRY_SNACK_SOLIDS = 60;

function deOil(f) {
  const nonFat = f.protein + f.carbs + f.fiber;
  const share = f.fat / (nonFat + f.fat);
  if (f.fat < OIL_FLAG_MIN_FAT || share < OIL_FLAG_MIN_SHARE || INTRINSICALLY_FATTY.test(f.name)) return null;
  if (DRY_SNACK.test(f.name)) {
    const k = DRY_SNACK_SOLIDS / nonFat;
    const out = { ...f, protein: r1(f.protein * k), carbs: r1(f.carbs * k), fat: DRY_SNACK_FAT, fiber: r1(f.fiber * k) };
    out.calories = Math.round(atwater(out));
    return out;
  }
  const keptFat = (TARGET_FAT_SHARE * nonFat) / (1 - TARGET_FAT_SHARE);
  const oilRemoved = f.fat - keptFat;               // grams of oil per 100 g of the original mixture
  const scale = 100 / (100 - oilRemoved);
  const out = {
    ...f,
    protein: r1(f.protein * scale),
    carbs: r1(f.carbs * scale),
    fat: r1(keptFat * scale),
    fiber: r1(f.fiber * scale),
  };
  out.calories = Math.round(atwater(out));
  return out;
}

// ── 2. Soups / sauces whose macros don't match their energy ─────────────
// e.g. "Egg drop soup": 27 kcal but 12.9 g protein + 13.5 g fat (≈178 kcal).
// The energy values are plausible for soups; the macro columns are inflated.
// Fix: scale the macros (and fiber) down so they agree with the listed energy.
const LIQUID = /soup|consomm|sauce/i;

// ── 3. Remaining macro/energy mismatches (non-liquid) ───────────────────
// The macro values are the plausible side here (e.g. Spaghetti bolognese 97 kcal vs 163 kcal
// from macros; reference values are ~130–160), so energy is recomputed from macros.
const MISMATCH_TOLERANCE = 0.2;
const MISMATCH_ABS_KCAL = 15;
const SPICE = /spice|masala|powder|phoran/i;

// ── 4. Individual entries ────────────────────────────────────────────────
// Entries replaced by a curated staple (the source values were wrong or on a dry basis).
const EXCLUDE = {
  'Boiled egg (Ubla anda)': 'Listed at 45 kcal / 4.4 g protein per 100 g — about a third of a real egg. Replaced by the curated "Egg, boiled".',
  'Plain dosa': 'Listed at 381 kcal per 100 g (dry-batter basis). Replaced by curated "Dosa, plain" (168 kcal).',
  'Poha': 'Listed at 295 kcal / 14 g fat per 100 g. Replaced by curated "Poha, cooked" (180 kcal).',
  'Hot tea (Garam Chai)': 'Listed at 16 kcal per 100 ml, too low for chai with milk and sugar. Replaced by curated chai entries.',
  'Sweet Lassi (Meethi lassi)': 'Listed at 36 kcal per 100 ml, too dilute for sweet lassi. Replaced by curated "Lassi, sweet".',
  'Rice dal porridge (Chawal dal ki khichdi/khichri)': 'Listed at 383 kcal per 100 g (dry-ingredient basis). Replaced by curated "Khichdi".',
  'Chapati/Roti': 'Duplicate of the curated "Roti / Chapati" entry, which carries household portions.',
  'Poori': 'Listed at 738 kcal / 77.6 g fat per 100 g (frying oil counted). Replaced by curated "Poori" (343 kcal).',
  'Bhatura': 'Listed at 793 kcal / 82.6 g fat per 100 g (frying oil counted). Replaced by curated "Bhatura" (332 kcal).',
  'Dhokla': 'Duplicate of the curated "Dhokla" entry, which carries household portions.',
  'Rice moong dal cheela (Chawal aur moong dal ka cheela)': 'Source counted both the cooking oil and none of the batter water (798 kcal per 100 g); no reliable correction. "Poshtik chilla/cheela" remains.',
  'Gram flour and semolina chilla/cheela/savory pancake (Besan suji chilla/cheela)': 'Same source error as the rice moong dal cheela (759 kcal per 100 g); removed.',
};
// Entries computed on a dry-ingredient basis: scale by the cooked-yield factor.
const SCALE = {
  'Tamarind rice (Chintapandu pulihora/Puliyodharai/Puli sadam/Huli anna)': [0.5, 'Dry-ingredient basis (373 kcal per 100 g); scaled ×0.5 to cooked weight.'],
  'Instant idli (with semolina)': [0.56, 'Dry-batter basis (247 kcal per 100 g vs 138 for regular idli); scaled ×0.56 to steamed weight.'],
};
const RENAME = {
  'Espreso coffee': 'Espresso coffee',
  'Vegeterian scotch egg': 'Vegetarian scotch egg',
  'Paaner do pyaza': 'Paneer do pyaza',
  'Plain khitchdi (Plain khichri/khichdi)': 'Plain khichdi (Plain khichri/khitchdi)',
};

// ── Categories for the recipe list (used for display and search ranking) ──
const CATEGORY_RULES = [
  [/soup|consomm|stock|yakhni$|shorba/i, 'Soups'],
  [/tea|coffee|lassi|shake|juice|drink|cooler|punch|lemonade|squash|sharbat|smoothie|nog|panna|pani|kanji|cocoa/i, 'Beverages'],
  [/sandwich|burger|toast|roll|pizza/i, 'Sandwiches & fast food'],
  [/pakora|pakoda|samosa|kachori|cutlet|vada|bonda|namak paras|mathri|chips|sev|papdi|murukku|kebab|tikki|fritter|fingers|chakli|chiwda|bhel|chaat|chat/i, 'Snacks & fried foods'],
  [/halwa|kheer|burfi|ladoo|laddu|jamun|jalebi|cake|pudding|pie|tart|cookie|biscuit|ice cream|custard|mousse|souffle|gateau|pastry|icing|payasam|rasgulla|sandesh|mal ?pua|gunjia|ghujia|chikki|sweet|meetha|dessert|cream horns|brittle|fudge|toffee|jelly|marmalade|jam/i, 'Sweets & desserts'],
  [/pickle|achaar|achar|chutney|raita|dip|sauce|dressing|mayonnaise|ketchup|baghar|tadka|masala$|powder|spice/i, 'Chutneys, pickles & sauces'],
  [/salad/i, 'Salads'],
  [/egg|omelette|omlet/i, 'Eggs'],
  [/chicken|mutton|fish|meat|keema|prawn|lamb|salami|machli/i, 'Meat & fish'],
  [/roti|chapati|paratha|parantha|poori|puri|bhatura|naan|kulcha|dosa|idli|uttapam|appam|cheela|chilla|bread|thepla/i, 'Grains & breads'],
  [/rice|pulao|biryani|biriyani|khichdi|khichri|khitchdi|upma|poha|daliya|porridge|noodle|pasta|spaghetti|macaroni|chowmein|lasagne/i, 'Grains & breads'],
  [/dal|daal|rajmah|rajma|chana|channa|chole|moong|masoor|urad|lentil|bean|sambar|kadhi/i, 'Dals & legumes'],
  [/paneer|curd|dahi|cheese/i, 'Dairy'],
];
const categorize = (name) => (CATEGORY_RULES.find(([re]) => re.test(name)) || [null, 'Mixed dishes'])[1];

const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

// ── Build ────────────────────────────────────────────────────────────────
const log = { oil: [], liquid: [], energy: [], excluded: [], scaled: [], renamed: [] };
const foods = [];
const ids = new Set();
const uniqueId = (base) => { let id = base, n = 2; while (ids.has(id)) id = `${base}-${n++}`; ids.add(id); return id; };

for (const [id, name, category, unit, calories, protein, carbs, fat, fiber, portions, aliases] of CORE_FOODS) {
  foods.push({
    id: uniqueId(id), name, category, servingSize: 100, servingUnit: unit,
    calories, protein, carbs, fat, fiber,
    portions: portions.map(([label, grams]) => ({ label, grams })),
    aliases, source: 'core',
  });
}

for (const item of raw) {
  const original = { name: item.n, calories: item.c, protein: item.p, carbs: item.cb, fat: item.f, fiber: item.fb };
  if (EXCLUDE[item.n]) { log.excluded.push([item.n, EXCLUDE[item.n]]); continue; }
  let f = { ...original };
  if (RENAME[f.name]) { log.renamed.push([f.name, RENAME[f.name]]); f.name = RENAME[f.name]; }
  let note;

  if (SCALE[item.n]) {
    const [k, why] = SCALE[item.n];
    f = { ...f, calories: Math.round(f.calories * k), protein: r1(f.protein * k), carbs: r1(f.carbs * k), fat: r1(f.fat * k), fiber: r1(f.fiber * k) };
    log.scaled.push([f.name, original, f, why]);
    note = 'scaled-to-cooked-weight';
  }

  const deOiled = deOil(f);
  if (deOiled) { log.oil.push([f.name, f, deOiled]); f = deOiled; note = 'frying-oil-removed'; }

  const macroKcal = atwater(f);
  const mismatch = f.calories > 0 && Math.abs(macroKcal - f.calories) > Math.max(MISMATCH_ABS_KCAL, MISMATCH_TOLERANCE * f.calories);
  if (mismatch && !SPICE.test(f.name)) {
    if (LIQUID.test(f.name) && macroKcal > f.calories) {
      const k = f.calories / macroKcal;
      const fixed = { ...f, protein: r1(f.protein * k), carbs: r1(f.carbs * k), fat: r1(f.fat * k), fiber: r1(f.fiber * k) };
      log.liquid.push([f.name, f, fixed]); f = fixed; note = 'macros-rescaled-to-energy';
    } else {
      const fixed = { ...f, calories: Math.round(macroKcal) };
      log.energy.push([f.name, f, fixed]); f = fixed; note = 'energy-recomputed-from-macros';
    }
  }

  foods.push({
    id: uniqueId('indb-' + slug(f.name)), name: f.name, category: categorize(f.name),
    servingSize: 100, servingUnit: 'g',
    calories: f.calories, protein: f.protein, carbs: f.carbs, fat: f.fat, fiber: f.fiber,
    portions: [], aliases: [], source: 'indb', ...(note ? { correction: note } : {}),
  });
}

// ── Validate: every item must be well-formed and macro-consistent ────────
const problems = [];
for (const f of foods) {
  for (const k of ['calories', 'protein', 'carbs', 'fat', 'fiber', 'servingSize']) {
    if (typeof f[k] !== 'number' || !Number.isFinite(f[k]) || f[k] < 0) problems.push(`${f.name}: bad ${k}`);
  }
  if (f.protein + f.carbs + f.fat > 101) problems.push(`${f.name}: macros exceed 100 g`);
  const m = atwater(f);
  const tol = Math.max(MISMATCH_ABS_KCAL, 0.25 * f.calories);
  if (!SPICE.test(f.name) && Math.abs(m - f.calories) > tol) problems.push(`${f.name}: ${f.calories} kcal vs ${Math.round(m)} from macros`);
}
const names = new Map();
for (const f of foods) { const k = f.name.toLowerCase(); if (names.has(k)) problems.push(`duplicate name: ${f.name}`); names.set(k, 1); }
if (problems.length) { console.error('Food DB validation failed:\n' + problems.join('\n')); process.exit(1); }

// ── Write outputs ────────────────────────────────────────────────────────
const header = `// GENERATED by scripts/build-food-db.mjs — do not edit by hand.
// Edit scripts/food-data/core-foods.mjs or the corrections in the build script, then run:
//   node scripts/build-food-db.mjs
//
// Every food has a base serving of 100 g (or 100 ml). Nutrition for any quantity is
//   value × quantityInGrams / servingSize
// "portions" are optional household measures (e.g. 1 roti = 40 g).
`;
const body = 'export const FOODS = [\n' + foods.map((f) => '  ' + JSON.stringify(f)).join(',\n') + '\n];\n';
writeFileSync(join(root, 'food_db.js'), header + body);

const fmtRow = (f) => `${f.calories} kcal · P ${f.protein} · C ${f.carbs} · F ${f.fat} · Fib ${f.fiber}`;
let md = `# Food database corrections\n\nGenerated by \`scripts/build-food-db.mjs\`. All values are per 100 g.\n\n`;
md += `Curated staples added: **${CORE_FOODS.length}**. Recipe entries kept: **${foods.length - CORE_FOODS.length}** of ${raw.length}.\n\n`;
md += `## 1. Frying oil removed (${log.oil.length})\n\nThe source counted the whole frying-oil vat as eaten. Oil was removed until fat is ${TARGET_FAT_SHARE * 100}% of macro mass, then values were re-expressed per 100 g of food.\n\n| Food | Before | After |\n|---|---|---|\n`;
md += log.oil.map(([n, a, b]) => `| ${n} | ${fmtRow(a)} | ${fmtRow(b)} |`).join('\n') + '\n\n';
md += `## 2. Soup/sauce macros rescaled to listed energy (${log.liquid.length})\n\n| Food | Before | After |\n|---|---|---|\n`;
md += log.liquid.map(([n, a, b]) => `| ${n} | ${fmtRow(a)} | ${fmtRow(b)} |`).join('\n') + '\n\n';
md += `## 3. Energy recomputed from macros (${log.energy.length})\n\n| Food | Before | After |\n|---|---|---|\n`;
md += log.energy.map(([n, a, b]) => `| ${n} | ${fmtRow(a)} | ${fmtRow(b)} |`).join('\n') + '\n\n';
md += `## 4. Scaled from dry basis to cooked weight (${log.scaled.length})\n\n`;
md += log.scaled.map(([n, , , why]) => `- **${n}** — ${why}`).join('\n') + '\n\n';
md += `## 5. Removed and replaced by curated staples (${log.excluded.length})\n\n`;
md += log.excluded.map(([n, why]) => `- **${n}** — ${why}`).join('\n') + '\n\n';
md += `## 6. Renamed (typos) (${log.renamed.length})\n\n` + log.renamed.map(([a, b]) => `- ${a} → ${b}`).join('\n') + '\n';
writeFileSync(join(here, 'food-data/CORRECTIONS.md'), md);

console.log(`food_db.js: ${foods.length} foods (${CORE_FOODS.length} curated, ${foods.length - CORE_FOODS.length} recipes)`);
console.log(`corrections: oil ${log.oil.length}, soups ${log.liquid.length}, energy ${log.energy.length}, scaled ${log.scaled.length}, excluded ${log.excluded.length}`);
