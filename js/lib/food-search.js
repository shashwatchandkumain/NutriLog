// Food search: exact, partial, spelling-tolerant, Hindi/English synonyms.
// Pure — unit-tested in tests/food-search.test.mjs.

// Groups of interchangeable words. Any word in a group matches the others.
const SYNONYM_GROUPS = [
  ['roti', 'chapati', 'chapatti', 'phulka', 'fulka', 'rotli'],
  ['dahi', 'curd', 'yogurt', 'yoghurt'],
  ['anda', 'egg', 'eggs', 'ande'],
  ['chawal', 'rice', 'bhaat', 'bhat'],
  ['aloo', 'alu', 'potato', 'potatoes'],
  ['gobi', 'gobhi', 'cauliflower', 'phoolgobhi'],
  ['patta gobhi', 'cabbage'],
  ['palak', 'spinach'],
  ['matar', 'mutter', 'peas'],
  ['paneer', 'panir', 'cottage cheese'],
  ['chana', 'channa', 'chole', 'chhole', 'chickpea', 'chickpeas'],
  ['rajma', 'rajmah', 'kidney bean', 'kidney beans'],
  ['murgh', 'murg', 'chicken'],
  ['machli', 'machhi', 'fish'],
  ['gosht', 'mutton', 'lamb', 'goat'],
  ['kela', 'banana'],
  ['seb', 'apple'],
  ['aam', 'mango'],
  ['doodh', 'milk'],
  ['chai', 'tea'],
  ['bhindi', 'okra', 'ladyfinger', "lady's fingers"],
  ['baingan', 'brinjal', 'eggplant', 'aubergine'],
  ['methi', 'fenugreek'],
  ['dal', 'daal', 'dhal', 'lentil', 'lentils'],
  ['moong', 'mung'],
  ['toor', 'arhar', 'tuvar'],
  ['makhana', 'fox nut', 'fox nuts'],
  ['sabzi', 'sabji', 'subzi'],
  ['paratha', 'parantha', 'parotta', 'prantha'],
  ['dosa', 'dosai'],
  ['idli', 'idly'],
  ['vada', 'wada', 'vadai'],
  ['pakora', 'pakoda', 'bhaji', 'bhajji', 'bhajiya'],
  ['kheer', 'payasam'],
  ['biryani', 'biriyani', 'biriani'],
  ['pulao', 'pulav', 'pilaf'],
  ['chaas', 'buttermilk', 'mattha'],
  ['jeera', 'zeera', 'cumin'],
  ['badam', 'almond', 'almonds'],
  ['moongfali', 'mungfali', 'peanut', 'peanuts', 'groundnut'],
  ['kaju', 'cashew', 'cashews'],
  ['gur', 'gud', 'jaggery'],
  ['ghee', 'clarified butter'],
  ['poori', 'puri'],
  ['khichdi', 'khichri', 'khitchdi', 'kitchari'],
  ['omelette', 'omelet', 'omlet'],
  ['tamatar', 'tomato'],
  ['pyaz', 'pyaaz', 'onion'],
  ['gajar', 'carrot'],
  ['kheera', 'kakdi', 'cucumber'],
];

/** Phonetic-ish key: lowercase, strip accents/punctuation, fold common transliteration variants. */
export function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function phonetic(word) {
  return word
    .replace(/(kh|gh|ch|jh|th|dh|ph|bh|sh)/g, (m) => m[0])
    .replace(/w/g, 'v').replace(/z/g, 'j').replace(/q/g, 'k').replace(/ck/g, 'k')
    .replace(/ee|ii/g, 'i').replace(/oo|uu|ou/g, 'u').replace(/aa/g, 'a')
    .replace(/(.)\1+/g, '$1')
    .replace(/h$/, '');
}

const SYNONYMS = new Map();
for (const group of SYNONYM_GROUPS) {
  const keys = group.map((w) => phonetic(normalize(w)));
  for (const k of keys) SYNONYMS.set(k, keys);
}

/** Levenshtein distance with an early exit once `max` is exceeded. */
export function editDistance(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

const tokens = (s) => normalize(s).split(' ').filter(Boolean).map(phonetic);

/** Precomputes normalized tokens for every food. Call once. */
export function buildIndex(foods) {
  return foods.map((food, i) => {
    const name = normalize(food.name);
    const aliasText = (food.aliases || []).map(normalize);
    return {
      i, food,
      name,
      nameTokens: tokens(food.name),
      aliasTokens: aliasText.flatMap((a) => a.split(' ').filter(Boolean).map(phonetic)),
      aliases: aliasText,
    };
  });
}

// How well one query token matches a food token list. 0 = no match.
function tokenScore(q, list) {
  let best = 0;
  const alts = SYNONYMS.get(q) || [q];
  for (const t of list) {
    for (const a of alts) {
      if (t === a) return a === q ? 10 : 9;
      if (a.length >= 2 && t.startsWith(a)) best = Math.max(best, a === q ? 7 : 6);
    }
    if (q.length >= 5 && t.length >= 4) {
      const d = editDistance(q, t.slice(0, Math.max(q.length, Math.min(t.length, q.length + 1))), 2);
      const allowed = q.length >= 7 ? 2 : 1;
      if (d <= allowed) best = Math.max(best, d === 1 ? 5 : 4);
    }
  }
  return best;
}

/**
 * Ranked search. Every query word must match (name, alias, synonym, prefix or small typo).
 * Curated staples and names starting with the query rank first.
 */
export function searchFoods(index, query, limit = 12) {
  const q = normalize(query);
  if (q.length < 2) return [];
  const qTokens = q.split(' ').filter(Boolean).map(phonetic);
  const results = [];
  for (const entry of index) {
    let score = 0;
    let matched = true;
    for (const qt of qTokens) {
      const s = Math.max(tokenScore(qt, entry.nameTokens), tokenScore(qt, entry.aliasTokens) - 1);
      if (!s) { matched = false; break; }
      score += s;
    }
    if (!matched) continue;
    if (entry.name === q || entry.aliases.includes(q)) score += 30;
    if (entry.name.startsWith(q)) score += 15;
    else if (phonetic(entry.nameTokens[0] || '') === qTokens[0]) score += 8;
    if (entry.food.source === 'core') score += 12;
    // Prefer shorter names: "Banana" before "Banana milkshake with ice cream".
    score -= Math.min(10, entry.nameTokens.length - qTokens.length) * 0.8;
    results.push({ score, entry });
  }
  results.sort((a, b) => b.score - a.score || a.entry.name.length - b.entry.name.length);
  return results.slice(0, limit).map((r) => r.entry.food);
}
