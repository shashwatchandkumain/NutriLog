// Vitamins and minerals for a day, from the values saved with each logged food (foods from the
// Global Food Database carry them; AI estimates and manual entries don't). Reference amounts are
// the US FDA Daily Values for adults — a general guide, not a personal target. Pure, unit-tested.
export const MICROS = [
  ['vitamin_a_ug', 'Vitamin A', 900, 'µg'], ['vitamin_c_mg', 'Vitamin C', 90, 'mg'], ['vitamin_d_ug', 'Vitamin D', 20, 'µg'],
  ['vitamin_e_mg', 'Vitamin E', 15, 'mg'], ['vitamin_k_ug', 'Vitamin K', 120, 'µg'], ['vitamin_b1_mg', 'Thiamin (B1)', 1.2, 'mg'],
  ['vitamin_b2_mg', 'Riboflavin (B2)', 1.3, 'mg'], ['vitamin_b3_mg', 'Niacin (B3)', 16, 'mg'], ['vitamin_b5_mg', 'Pantothenic acid (B5)', 5, 'mg'],
  ['vitamin_b6_mg', 'Vitamin B6', 1.7, 'mg'], ['vitamin_b9_ug', 'Folate (B9)', 400, 'µg'], ['vitamin_b12_ug', 'Vitamin B12', 2.4, 'µg'],
  ['calcium_mg', 'Calcium', 1300, 'mg'], ['iron_mg', 'Iron', 18, 'mg'], ['magnesium_mg', 'Magnesium', 420, 'mg'],
  ['phosphorus_mg', 'Phosphorus', 1250, 'mg'], ['potassium_mg', 'Potassium', 4700, 'mg'], ['zinc_mg', 'Zinc', 11, 'mg'],
  ['copper_mg', 'Copper', 0.9, 'mg'], ['manganese_mg', 'Manganese', 2.3, 'mg'], ['selenium_ug', 'Selenium', 55, 'µg'],
];

/** → { rows: [{ key, label, unit, amount, dv, pct }], withData, foods } */
export function dayMicros(items) {
  const totals = {};
  let withData = 0;
  for (const it of items || []) {
    const m = it.micros && typeof it.micros === 'object' ? it.micros : null;
    if (!m || !Object.keys(m).length) continue;
    withData++;
    for (const [k, v] of Object.entries(m)) if (Number.isFinite(Number(v))) totals[k] = (totals[k] || 0) + Number(v);
  }
  const rows = MICROS.filter(([k]) => totals[k] != null).map(([key, label, dv, unit]) => ({ key, label, unit, amount: totals[key], dv, pct: (totals[key] / dv) * 100 }));
  return { rows, withData, foods: (items || []).length };
}
