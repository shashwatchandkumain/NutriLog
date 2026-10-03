// Reads a typed or spoken meal ("1 roti with 10g butter and 4 boiled eggs") into food items with
// quantities — on the device, without AI. When the text is too free-form to be sure, `complete`
// is false and the app asks the AI to parse it instead. Pure functions, unit-tested.

const NUMBER_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, couple: 2, half: 0.5, quarter: 0.25,
  ek: 1, teen: 3, char: 4, chaar: 4, panch: 5, paanch: 5, chhe: 6, saat: 7, aath: 8, dedh: 1.5, dhai: 2.5, aadha: 0.5, adha: 0.5, aadhi: 0.5, adhi: 0.5,
};
const WORD_NUM = Object.keys(NUMBER_WORDS).join('|');

/** User's unit → canonical unit. */
const UNITS = {
  g: 'g', gm: 'g', gms: 'g', gram: 'g', grams: 'g', gr: 'g', grm: 'g',
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  ml: 'ml', mls: 'ml', millilitre: 'ml', milliliter: 'ml', millilitres: 'ml', milliliters: 'ml',
  l: 'l', ltr: 'l', litre: 'l', liter: 'l', litres: 'l', liters: 'l',
  cup: 'cup', cups: 'cup', glass: 'glass', glasses: 'glass', katori: 'katori', katoris: 'katori', bowl: 'bowl', bowls: 'bowl',
  plate: 'plate', plates: 'plate', piece: 'piece', pieces: 'piece', pc: 'piece', pcs: 'piece', slice: 'slice', slices: 'slice',
  tbsp: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp', tsp: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp', spoon: 'tsp', spoons: 'tsp', chammach: 'tsp',
  scoop: 'scoop', scoops: 'scoop', serving: 'serving', servings: 'serving', handful: 'handful', handfuls: 'handful',
  packet: 'packet', packets: 'packet', pack: 'packet', can: 'can', cans: 'can', mug: 'cup', mugs: 'cup',
};
const UNIT_RE = Object.keys(UNITS).sort((a, b) => b.length - a.length).join('|');
const VAGUE = /^(a little|little|a bit of|a bit|bit of|some|a few|few|thoda|thodi|thoda sa|thodi si|a splash of|a pinch of|a dash of|a drizzle of|a touch of)\b\s*/;

/** Any unit word → NutriLog's unit ("grams" → "g", "katoris" → "katori"), or null. */
export const normalizeUnit = (u) => (u ? UNITS[String(u).toLowerCase().trim()] || String(u).toLowerCase().trim() : null);

/** "1/2" → 0.5, "1.5" → 1.5, "dedh" → 1.5, "two" → 2 */
function toNumber(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (/^\d+\/\d+$/.test(t)) { const [a, b] = t.split('/').map(Number); return b ? a / b : null; }
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  return NUMBER_WORDS[t] ?? null;
}

/** Lower-cases and removes "I had", "for breakfast" etc.; turns "one and a half" into 1.5. */
export function cleanMealText(text) {
  let t = ` ${String(text ?? '').toLowerCase()} `
    .replace(/½/g, ' 1/2').replace(/¼/g, ' 1/4').replace(/¾/g, ' 3/4')
    .replace(/[“”"]/g, ' ').replace(/\s+/g, ' ');
  t = t.replace(/\b(i|we|i've|i have|i just|maine|mene|humne)\s+(just\s+)?(ate|had|have eaten|eaten|drank|have had|khaya|khaye|khayi|piya|liya|li)\b/g, ' ')
    .replace(/\b(for|in|at)\s+(breakfast|lunch|dinner|snacks?|brunch|today|tonight|the morning|the evening|the afternoon)\b/g, ' ')
    .replace(/\b(today|aaj|abhi|just now|this morning|tonight|for me)\b/g, ' ')
    .replace(/\b(ate|had|khaya|khaye|piya)\b/g, ' ');
  // "one and a half eggs", "2 and a half rotis", "1 1/2 cups"
  t = t.replace(new RegExp(`\\b(\\d+|${WORD_NUM})\\s+and\\s+a\\s+half\\b`, 'g'), (_, n) => ` ${toNumber(n) + 0.5} `)
    .replace(/\b(\d+)\s+(\d+)\/(\d+)\b/g, (_, w, a, b) => ` ${Number(w) + Number(a) / Number(b)} `)
    .replace(/\bhalf\s+(a|an)\b/g, ' half ');
  return t.replace(/\s+/g, ' ').trim();
}

// Separators between foods. "with" also links the food to the previous one ("egg with butter").
const SPLIT = /\s*(,|;|\+|&|\band also\b|\balong with\b|\bwith\b|\bke saath\b|\bke sath\b|\bsaath mein\b|\band\b|\baur\b|\bplus\b|\bthen\b)\s*/;

/** One chunk ("4 boiled eggs", "10g butter", "a little ghee") → { name, quantity, unit, vague } */
export function parseChunk(chunk) {
  let s = ` ${chunk} `.replace(/\s+/g, ' ').replace(/\b(\d+)\s+(\d+)\/(\d+)\b/g, (_, w, a, b) => `${Number(w) + Number(a) / Number(b)}`).trim();
  let vague = false;
  let quantity = null;
  let unit = null;
  const vm = VAGUE.exec(s);
  if (vm) { vague = true; s = s.slice(vm[0].length); }
  // Leading amount: "4", "1.5", "1/2", "two", "200g", "200 g", "2 cups of", "a katori of"
  const lead = new RegExp(`^(\\d+/\\d+|\\d+(?:\\.\\d+)?|${WORD_NUM})?\\s*(?:x\\s*)?(${UNIT_RE})?(?:\\s+of)?\\b\\s*`).exec(s);
  if (lead && (lead[1] || lead[2])) {
    // "a" alone before a food means one ("an egg"); before a unit it means one unit ("a katori dal").
    quantity = toNumber(lead[1]);
    if (lead[2]) unit = UNITS[lead[2]];
    if (lead[1] && !lead[2] && UNITS[lead[1]]) { unit = UNITS[lead[1]]; quantity = null; }
    s = s.slice(lead[0].length);
  }
  // Trailing amount: "rice 200g", "eggs x 4", "dal 1 katori"
  if (quantity == null && !unit) {
    const tail = new RegExp(`\\s+(?:x\\s*)?(\\d+/\\d+|\\d+(?:\\.\\d+)?)\\s*(${UNIT_RE})?$`).exec(s);
    if (tail) { quantity = toNumber(tail[1]); if (tail[2]) unit = UNITS[tail[2]]; s = s.slice(0, tail.index); }
  }
  if (unit && quantity == null && !vague) quantity = 1;
  const name = s.replace(/^(of|the)\s+/, '').replace(/[.!?]+$/, '').replace(/\s+/g, ' ').trim();
  return { name, quantity, unit, vague };
}

/**
 * The whole meal → { items: [{ text, name, quantity, unit, vague, modifierOf }], complete }.
 * `complete` is true only when every part was understood with confidence.
 */
export function parseMealText(text) {
  const clean = cleanMealText(text);
  if (!clean) return { items: [], complete: false };
  const parts = clean.split(SPLIT);
  const items = [];
  let nextIsModifier = false;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (i % 2 === 1) { nextIsModifier = /with|saath|sath/.test(p); continue; } // a separator
    if (!p.trim()) continue;
    const it = parseChunk(p);
    items.push({ text: p.trim(), ...it, modifierOf: nextIsModifier && items.length ? items.length - 1 : null });
    nextIsModifier = false;
  }
  const complete = items.length > 0 && items.length <= 12 && items.every((it) =>
    it.name && /^[a-z][a-z' -]*$/.test(it.name) && it.name.split(' ').length <= 4 && (it.quantity == null || it.quantity > 0));
  return { items, complete };
}
