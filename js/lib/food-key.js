// The matching key for food names in the Global Food Database: lower-case words, plurals made
// singular, filler words dropped, sorted — so "Boiled Eggs", "egg boiled" and "boiled egg" all
// become "boiled egg". public.food_key() in supabase/migrations/005_global_foods.sql is the same
// function in SQL; a database test keeps the two identical.
const STOP = new Set(['a', 'an', 'the', 'of', 'and', 'with', 'some']);

/** Singular form of one lower-case word (simple English rules; leaves short words alone). */
export function singular(w) {
  if (/(ss|us|is)$/.test(w)) return w;
  if (w.length > 4 && /ies$/.test(w)) return w.replace(/ies$/, 'y');
  if (w.length > 4 && /(ch|sh|x|o)es$/.test(w)) return w.replace(/es$/, '');
  if (w.length > 3 && /s$/.test(w)) return w.replace(/s$/, '');
  return w;
}

/** "Boiled Eggs" → "boiled egg"; "Roti / Chapati" → "chapati roti". */
export function nameKey(name) {
  const words = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter((w) => w && !STOP.has(w)).map(singular);
  return [...new Set(words)].sort().join(' ');
}
