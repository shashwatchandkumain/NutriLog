// Server-side normalization of AI nutrition output.
// The model only estimates per-100 g values and the portion weight; all totals are computed
// here as per100 × grams / 100, so arithmetic mistakes by the model can't reach the log.

export const PER_100G_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['calories', 'protein', 'carbs', 'fat', 'fiber'],
  properties: {
    calories: { type: 'number', description: 'kcal per 100 g as eaten' },
    protein: { type: 'number', description: 'grams per 100 g' },
    carbs: { type: 'number', description: 'total carbohydrate grams per 100 g' },
    fat: { type: 'number', description: 'grams per 100 g' },
    fiber: { type: 'number', description: 'grams per 100 g' },
  },
};

export const FOOD_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['food_name', 'portion_description', 'grams', 'per_100g', 'confidence'],
  properties: {
    food_name: { type: 'string', description: 'Short, specific name, e.g. "Chicken biryani"' },
    portion_description: { type: 'string', description: 'Human portion, e.g. "1 plate (~300 g)"' },
    grams: { type: 'number', description: 'Estimated edible weight in grams (ml for drinks)' },
    per_100g: PER_100G_SCHEMA,
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
};

export const FOOD_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: { items: { type: 'array', items: FOOD_ITEM_SCHEMA } },
};

export const FOOD_RULES = `Rules:
- One entry per distinct food or drink. Split combined meals ("dal chawal" -> dal + rice).
- per_100g values are for the food AS EATEN (cooked, with typical oil/ghee for home-style Indian cooking), from standard references (IFCT 2017, USDA FoodData Central).
- Distinguish raw vs cooked (cooked chicken breast ~31 g protein/100 g; raw ~22.5 g).
- grams is the eaten weight. Use quantities the user gives ("2 roti", "300 g rice"); otherwise assume one typical serving. Typical weights: roti 40 g, phulka 30 g, katori of dal/sabzi 150 g, cup of cooked rice 158 g, idli 40 g, dosa 75 g, large egg 50 g, medium banana 118 g, slice of bread 25-28 g, glass of milk 250 ml.
- calories per 100 g must be close to protein*4 + carbs*4 + fat*9.
- Never exceed 900 kcal or 100 g of macros per 100 g.
- If the input is not food, return an empty items array.`;

type Per100 = { calories: number; protein: number; carbs: number; fat: number; fiber: number };

const num = (v: unknown, lo: number, hi: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : NaN;
};
const round2 = (v: number) => Math.round(v * 100) / 100;

export interface NormalizedFood {
  food_name: string;
  portion_description: string;
  grams: number;
  per_100g: Per100;
  calories: number; protein: number; carbs: number; fat: number; fiber: number;
  confidence: 'high' | 'medium' | 'low';
  warnings: string[];
}

export function normalizeFoods(raw: unknown): NormalizedFood[] {
  const list = Array.isArray((raw as { items?: unknown })?.items) ? (raw as { items: unknown[] }).items
    : Array.isArray(raw) ? raw : [];
  const out: NormalizedFood[] = [];
  for (const it of list.slice(0, 20) as Record<string, unknown>[]) {
    const name = String(it?.food_name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const grams = num(it?.grams, 1, 5000);
    const p = (it?.per_100g ?? {}) as Record<string, unknown>;
    const per: Per100 = {
      calories: num(p.calories, 0, 902), protein: num(p.protein, 0, 100), carbs: num(p.carbs, 0, 100),
      fat: num(p.fat, 0, 100), fiber: num(p.fiber ?? 0, 0, 100),
    };
    if (!name || !Number.isFinite(grams) || Object.values(per).some((v) => !Number.isFinite(v))) continue;
    if (per.protein + per.carbs + per.fat > 100.5) continue; // physically impossible — drop
    const warnings: string[] = [];
    const macroKcal = per.protein * 4 + per.carbs * 4 + per.fat * 9;
    if (Math.abs(macroKcal - per.calories) > Math.max(15, 0.2 * Math.max(per.calories, macroKcal))) {
      warnings.push('calories_adjusted_to_macros');
      per.calories = Math.round(macroKcal);
    }
    const f = grams / 100;
    const confidence = ['high', 'medium', 'low'].includes(String(it?.confidence)) ? it.confidence as NormalizedFood['confidence'] : 'medium';
    out.push({
      food_name: name,
      portion_description: String(it?.portion_description ?? '').trim().slice(0, 80) || `${Math.round(grams)} g`,
      grams: round2(grams),
      per_100g: per,
      calories: round2(per.calories * f), protein: round2(per.protein * f), carbs: round2(per.carbs * f),
      fat: round2(per.fat * f), fiber: round2(per.fiber * f),
      confidence, warnings,
    });
  }
  return out;
}

// ── Activities ──────────────────────────────────────────────────────────
export const ACTIVITY_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['activity_name', 'duration_min', 'met'],
        properties: {
          activity_name: { type: 'string' },
          duration_min: { type: 'number', description: 'Minutes; assume 30 if not stated' },
          met: { type: 'number', description: 'MET value from the Compendium of Physical Activities' },
        },
      },
    },
  },
};

/** Net calories above resting: (MET − 1) × kg × hours. Resting energy is already in TDEE. */
export function normalizeActivities(raw: unknown, weightKg: number) {
  const list = Array.isArray((raw as { items?: unknown })?.items) ? (raw as { items: unknown[] }).items : [];
  return (list.slice(0, 10) as Record<string, unknown>[]).map((a) => {
    const name = String(a?.activity_name ?? '').trim().slice(0, 120);
    const minutes = num(a?.duration_min, 1, 600);
    const met = num(a?.met, 1, 23);
    if (!name || !Number.isFinite(minutes) || !Number.isFinite(met)) return null;
    return {
      name, duration_min: Math.round(minutes), met: round2(met),
      calories_burned: Math.round(Math.max(0, met - 1) * weightKg * (minutes / 60)),
    };
  }).filter(Boolean);
}
