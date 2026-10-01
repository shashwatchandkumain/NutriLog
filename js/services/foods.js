// Food database access (lazy-loaded), portion units, barcode lookup, image preparation.
import { buildIndex, searchFoods } from '../lib/food-search.js';
import { checkConsistency, scaleNutrition } from '../lib/nutrition.js';
import { UserError } from '../lib/utils.js';

let foods = null;
let index = null;
let byId = null;
let loading = null;

/**
 * Loads the food database once. Browsers remember a failed module import for the page's
 * lifetime, so a retry after a network failure uses a fresh URL.
 */
export function loadFoods() {
  if (foods) return Promise.resolve(foods);
  loading ||= (async () => {
    let mod;
    try { mod = await import('../../food_db.js'); } catch (e) {
      console.warn('[NutriLog] food database load failed, retrying', e);
      try { mod = await import(`../../food_db.js?retry=${Date.now()}`); } catch (e2) {
        loading = null;
        throw new UserError("Couldn't load the food database. Check your connection and try again.", e2);
      }
    }
    foods = mod.FOODS;
    index = buildIndex(foods);
    byId = new Map(foods.map((f) => [f.id, f]));
    return foods;
  })();
  return loading;
}

export async function search(query, limit = 15) {
  await loadFoods();
  return searchFoods(index, query, limit);
}

export const getFood = (id) => byId?.get(id) || null;

/**
 * Units a food can be logged in. Each unit converts to grams (or ml for drinks).
 * Portions come first so "1 medium roti" is the default instead of "100 g".
 */
export function unitsFor(food) {
  const base = food.servingUnit === 'ml' ? 'ml' : 'g';
  // `short` is what gets stored as the unit: "1 medium roti" → "medium roti", so 3 of them reads "3 medium roti".
  const units = (food.portions || []).map((p, i) => ({
    id: `p${i}`, label: `${p.label} (${fmtG(p.grams)} ${base})`, grams: p.grams,
    short: p.label.replace(/^1\s+/, '').split(' — ')[0].slice(0, 60),
  }));
  units.push({ id: base, label: base === 'ml' ? 'millilitres (ml)' : 'grams (g)', short: base, grams: 1 });
  return units;
}

export function defaultQuantity(food) {
  const units = unitsFor(food);
  return units[0].id === 'g' || units[0].id === 'ml' ? { unit: units[0], quantity: 100 } : { unit: units[0], quantity: 1 };
}

const fmtG = (g) => (Math.round(g * 10) / 10).toString();

/** A meal item (for logging) from a database food and a chosen quantity/unit. */
export function itemFromFood(food, quantity, unit, source = 'database') {
  const grams = quantity * unit.grams;
  const n = scaleNutrition(food, grams);
  return {
    food_id: food.id || null,
    food_name: food.name,
    source,
    quantity,
    unit: unit.id === 'g' || unit.id === 'ml' ? unit.id : unit.short,
    grams,
    ...n,
  };
}

// ── Barcode (Open Food Facts, public API, no key) ─────────────────────────
export async function lookupBarcode(code) {
  const digits = String(code).replace(/\D/g, '');
  if (digits.length < 6 || digits.length > 14) throw new UserError("That doesn't look like a product barcode.");
  const fields = 'product_name,product_name_en,brands,nutriments,serving_size,serving_quantity,nutrition_data_per,quantity';
  let res;
  try {
    res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${digits}.json?fields=${fields}`, { headers: { Accept: 'application/json' } });
  } catch (e) {
    throw new UserError("Couldn't reach the product database. Check your connection.", e);
  }
  if (res.status === 404) throw new UserError('Product not found. Try searching by name or describe it to AI.');
  if (!res.ok) throw new UserError('The product database is unavailable right now.');
  const data = await res.json();
  if (data.status !== 1 || !data.product) throw new UserError('Product not found. Try searching by name or describe it to AI.');
  const p = data.product;
  const n = p.nutriments || {};
  const num = (v) => { const x = Number(v); return Number.isFinite(x) && x >= 0 ? x : null; };
  let kcal = num(n['energy-kcal_100g']);
  if (kcal == null && num(n.energy_100g) != null) kcal = num(n.energy_100g) / 4.184; // kJ → kcal
  const food = {
    id: `off:${digits}`,
    name: [p.product_name_en || p.product_name || 'Unknown product', p.brands ? `(${String(p.brands).split(',')[0].trim()})` : ''].join(' ').trim().slice(0, 150),
    category: 'Packaged food',
    servingSize: 100,
    servingUnit: /ml/i.test(p.nutrition_data_per || '') || /\bml\b/i.test(p.quantity || '') ? 'ml' : 'g',
    calories: kcal ?? 0,
    protein: num(n.proteins_100g) ?? 0,
    carbs: num(n.carbohydrates_100g) ?? 0,
    fat: num(n.fat_100g) ?? 0,
    fiber: num(n.fiber_100g) ?? 0,
    portions: [],
    source: 'barcode',
    missing: kcal == null,
  };
  const sq = num(p.serving_quantity);
  if (sq && sq > 0 && sq < 2000) food.portions.push({ label: `1 serving${p.serving_size ? ` — ${String(p.serving_size).slice(0, 30)}` : ''}`, grams: sq });
  food.consistent = checkConsistency(food).ok;
  return food;
}

// ── Images ────────────────────────────────────────────────────────────────
/** Downscales an image (File or canvas) to ≤ maxSide px JPEG and returns base64 + a preview URL. */
export async function prepareImage(source, maxSide = 1024) {
  let bitmap;
  if (source instanceof HTMLCanvasElement) bitmap = source;
  else {
    if (!source.type?.startsWith('image/')) throw new UserError('Please choose an image file.');
    if (source.size > 25 * 1024 * 1024) throw new UserError('That image is too large.');
    bitmap = await loadImage(source);
  }
  const w = bitmap.width, h = bitmap.height;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
  return { mediaType: 'image/jpeg', base64: dataUrl.split(',')[1], dataUrl };
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new UserError("Couldn't read that image.")); };
    img.src = url;
  });
}
