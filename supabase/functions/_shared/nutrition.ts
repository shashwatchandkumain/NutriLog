// Server-side normalization of AI nutrition output.
// The model only estimates per-100 g macros and the portion weight. Energy is computed here
// from the macros (4·protein + 4·carbs + 9·fat + 7·alcohol) and all totals as
// per100 × grams / 100 — so arithmetic slips, and each model's habit of rounding calories low
// or high, can't reach the log. Both models also share one rule set and reference table.
import { REFERENCE_TABLE } from './reference-foods.ts';

export const PER_100G_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['calories', 'protein', 'carbs', 'fat', 'fiber', 'alcohol'],
  properties: {
    calories: { type: 'number', description: 'kcal per 100 g as eaten (= 4·protein + 4·carbs + 9·fat + 7·alcohol)' },
    protein: { type: 'number', description: 'grams per 100 g' },
    carbs: { type: 'number', description: 'total carbohydrate grams per 100 g (including fiber)' },
    fat: { type: 'number', description: 'grams per 100 g' },
    fiber: { type: 'number', description: 'grams per 100 g' },
    alcohol: { type: 'number', description: 'grams of alcohol per 100 g; 0 unless an alcoholic drink' },
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

export const FOOD_RULES = `Estimation protocol (follow exactly — results must not depend on which AI model you are):
- One entry per distinct food or drink. Split combined meals ("dal chawal" -> dal + rice; "chole bhature" -> chole + bhature).
- Give the single MOST LIKELY value for every number — not a cautious low estimate and not a generous high one.
- per_100g is the food AS EATEN (cooked, including its cooking oil/ghee/sugar), from standard references (IFCT 2017, USDA FoodData Central). When a food matches a REFERENCE row below, use that row's per-100 g values and its portion weights unchanged.
- Cooking fat (the biggest source of error): home-style dal, sabzi or curry has about 1 tsp (4.5 g) oil or ghee per 150 g katori; restaurant / dhaba / hotel versions about 2.5× that. Add 5 g ghee per roti or paratha only if the user says "ghee" or "butter". Deep-fried foods: use the fried values (samosa, pakora, poori, bhatura rows).
- Raw vs cooked matters (cooked chicken breast 31 g protein/100 g; raw 22.5 g). Dal and rice weights are cooked weights.
- grams is the eaten weight (ml for drinks). Use amounts the user gives ("2 roti", "300 g rice", "1 katori"); otherwise one standard serving below or from the reference portions. Don't round to convenient numbers.
- Standard servings (cooked weight, home-style):
  roti/chapati 40 g · phulka 30 g · plain paratha 60 g + 1 tsp (5 g) oil/ghee · stuffed paratha (aloo, gobi, paneer, mooli) 120 g = 40 g atta + 60 g filling, + 1 tsp oil/ghee · naan 90 g · poori 25 g · bhatura 80 g
  rice, pulao, khichdi: 1 katori 150 g, 1 plate 250 g · biryani: 1 plate 350 g
  dal, sabzi, curry, kadhi, sambar, rajma, chole: 1 katori 150 g · raita or curd: 1 katori 150 g
  idli 40 g · plain dosa 75 g · masala dosa 75 g dosa + 75 g potato masala · medu vada 50 g · uttapam 120 g · upma or poha: 1 plate 200 g
  milk, lassi, buttermilk: 1 glass 250 ml · chai or coffee: 1 cup 150 ml · chutney 1 tbsp 15 g · pickle 1 tsp 5 g · roasted papad 10 g
  butter or ghee "with/on" bread: 1 tsp (5 g) per roti, paratha or slice unless an amount is given
- For a dish that is not in the reference, build it from its standard recipe (ingredients + cooking fat above) rather than guessing a calorie density.
- carbs = total carbohydrate including fiber; calories per 100 g = 4×protein + 4×carbs + 9×fat + 7×alcohol.
- Never exceed 900 kcal or 100 g of macros per 100 g.
- If the input is not food, return an empty items array.

REFERENCE (per 100 g or 100 ml as eaten):
${REFERENCE_TABLE}`;

type Per100 = { calories: number; protein: number; carbs: number; fat: number; fiber: number };

/** kcal from macros (general Atwater factors), the same rule the app uses everywhere. */
export const energyFromMacros = (p: number, c: number, f: number, alcohol = 0) => p * 4 + c * 4 + f * 9 + alcohol * 7;

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
}

export function normalizeFoods(raw: unknown): NormalizedFood[] {
  const list = Array.isArray((raw as { items?: unknown })?.items) ? (raw as { items: unknown[] }).items
    : Array.isArray(raw) ? raw : [];
  const out: NormalizedFood[] = [];
  for (const it of list.slice(0, 20) as Record<string, unknown>[]) {
    const name = String(it?.food_name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const grams = num(it?.grams, 1, 5000);
    const p = (it?.per_100g ?? {}) as Record<string, unknown>;
    const macros = { protein: num(p.protein, 0, 100), carbs: num(p.carbs, 0, 100), fat: num(p.fat, 0, 100), fiber: num(p.fiber ?? 0, 0, 100) };
    const alcohol = Number.isFinite(Number(p.alcohol)) ? Math.min(50, Math.max(0, Number(p.alcohol))) : 0;
    if (!name || !Number.isFinite(grams) || Object.values(macros).some((v) => !Number.isFinite(v))) continue;
    if (macros.protein + macros.carbs + macros.fat + alcohol > 100.5) continue; // physically impossible — drop
    const per: Per100 = {
      ...macros,
      fiber: Math.min(macros.fiber, macros.carbs), // fiber is part of total carbohydrate
      calories: round2(energyFromMacros(macros.protein, macros.carbs, macros.fat, alcohol)),
    };
    if (per.calories > 902) continue;
    const f = grams / 100;
    const confidence = ['high', 'medium', 'low'].includes(String(it?.confidence)) ? it.confidence as NormalizedFood['confidence'] : 'medium';
    out.push({
      food_name: name,
      portion_description: String(it?.portion_description ?? '').trim().slice(0, 80) || `${Math.round(grams)} g`,
      grams: round2(grams),
      per_100g: per,
      calories: round2(per.calories * f), protein: round2(per.protein * f), carbs: round2(per.carbs * f),
      fat: round2(per.fat * f), fiber: round2(per.fiber * f),
      confidence,
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

/**
 * Net calories above resting: (MET − 1) × kg × hours, with the MET and minutes exactly as
 * stored (2-decimal MET, whole minutes), so the app and the database get the same number.
 */
export function normalizeActivities(raw: unknown, weightKg: number) {
  const list = Array.isArray((raw as { items?: unknown })?.items) ? (raw as { items: unknown[] }).items : [];
  return (list.slice(0, 10) as Record<string, unknown>[]).map((a) => {
    const name = String(a?.activity_name ?? '').trim().slice(0, 120);
    const minutes = Math.round(num(a?.duration_min, 1, 600));
    const met = round2(num(a?.met, 1, 23));
    if (!name || !Number.isFinite(minutes) || !Number.isFinite(met)) return null;
    return { name, duration_min: minutes, met, calories_burned: round2(Math.max(0, met - 1) * weightKg * (minutes / 60)) };
  }).filter(Boolean);
}
