// Two small AI jobs for the Global Food Database flow:
//   parse    — turn "1 roti with a little butter and 4 boiled eggs" into food items with
//              quantities and the exact words they came from. No nutrition.
//   estimate — nutrition per 100 g for foods NutriLog's database doesn't know yet.
// The app looks every parsed item up in the shared database first; only unknown foods are
// estimated, so known foods never cost an AI call for their nutrition.
import { energyFromMacros, FOOD_RULES_CORE } from './nutrition.ts';

// ── Parse ─────────────────────────────────────────────────────────────────
export const PARSE_SYSTEM = `You split a person's description of what they ate into food items. You do NOT estimate nutrition.
Rules — the user's text is the only source of truth:
- Return ONLY foods and drinks the user actually mentioned. Never add foods that are often eaten together (no bread, toast, rice, butter, oil, sugar, chutney or drinks unless the user wrote them).
- text_span: copy the exact words from the user's text that name this item, including its quantity (e.g. "4 boiled eggs", "a little butter"). It must appear verbatim in the text.
- food_name: a short, standard English name with the preparation ("boiled egg", "half fried egg", "roti", "dal tadka", "butter"). Translate Hindi/Hinglish ("anda" → "boiled egg" only if it says boiled/ubla; plain "anda" → "egg").
- quantity and unit exactly as stated. Numbers in words become numbers ("one and a half" → 1.5, "half" → 0.5, "dedh" → 1.5, "dhai" → 2.5). unit is the user's unit ("g", "ml", "katori", "cup", "glass", "slice", "tbsp", "tsp", "piece", "plate", "bowl", "scoop") or null when they just counted items ("4 eggs" → quantity 4, unit null).
- If the amount is vague ("a little", "some", "thoda", "a bit") set amount_vague true and quantity null — do not guess a number.
- If nothing is stated, quantity null and amount_vague false (one standard serving will be offered).
- preparation: the cooking method the user stated (boiled, fried, half-fried, scrambled, grilled, raw…) or null. Keep it — don't change "half-fried" to "fried".
- modifier_of: when an item is added to another one ("egg WITH a little butter", "roti with ghee"), the 0-based index of that other item; otherwise null.
- If the text is not about food, return an empty items array.`;

export const PARSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text_span', 'food_name', 'quantity', 'unit', 'amount_vague', 'preparation', 'modifier_of'],
        properties: {
          text_span: { type: 'string' },
          food_name: { type: 'string' },
          quantity: { anyOf: [{ type: 'number' }, { type: 'null' }] },
          unit: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          amount_vague: { type: 'boolean' },
          preparation: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          modifier_of: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
        },
      },
    },
  },
};

export interface ParsedItem {
  text_span: string;
  food_name: string;
  quantity: number | null;
  unit: string | null;
  amount_vague: boolean;
  preparation: string | null;
  modifier_of: number | null;
}

const words = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ऀ-ॿ.]+/g, ' ').trim();

/**
 * Keeps only items whose text_span really is in the user's text — the guard against foods the
 * model "adds" (e.g. white bread nobody mentioned). Cleans every field.
 */
export function validateParsed(raw: unknown, userText: string): ParsedItem[] {
  const list = Array.isArray((raw as { items?: unknown })?.items) ? (raw as { items: unknown[] }).items : [];
  const text = ` ${words(userText)} `;
  const out: ParsedItem[] = [];
  const keep = new Map<number, number>(); // model index → our index
  list.slice(0, 20).forEach((r, i) => {
    const it = (r ?? {}) as Record<string, unknown>;
    const span = words(String(it.text_span ?? ''));
    const name = String(it.food_name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!span || !name || !text.includes(` ${span} `)) return;
    const q = Number(it.quantity);
    const vague = it.amount_vague === true;
    keep.set(i, out.length);
    out.push({
      text_span: String(it.text_span).trim().slice(0, 120),
      food_name: name,
      quantity: !vague && Number.isFinite(q) && q > 0 && q <= 5000 ? Math.round(q * 1000) / 1000 : null,
      unit: typeof it.unit === 'string' && it.unit.trim() ? it.unit.trim().toLowerCase().slice(0, 30) : null,
      amount_vague: vague,
      preparation: typeof it.preparation === 'string' && it.preparation.trim() ? it.preparation.trim().toLowerCase().slice(0, 40) : null,
      modifier_of: Number.isInteger(it.modifier_of) ? Number(it.modifier_of) : null,
    });
  });
  // Re-point modifiers at the kept items (or drop the link if its target was removed).
  for (const it of out) it.modifier_of = it.modifier_of != null && keep.has(it.modifier_of) ? keep.get(it.modifier_of)! : null;
  for (const [i, it] of out.entries()) if (it.modifier_of === i) it.modifier_of = null;
  return out;
}

// ── Estimate ──────────────────────────────────────────────────────────────
export const ESTIMATE_SYSTEM = `You are a precise nutrition analyst for an Indian-first calorie tracker. For each food given, return its nutrition per 100 g as eaten and its common servings. Estimate only the foods listed — never add others.
- grams: the eaten weight for the amount the user stated (quantity × unit). If the amount is vague or missing, use one standard serving.
- servings: 1-3 common household servings with gram weights (e.g. "1 tbsp" 15 g, "1 katori" 150 g, "1 piece" 60 g). Include the user's unit when they gave one.
- Optional values (sugar, saturated_fat, sodium_mg, cholesterol_mg): give them only if you are confident; otherwise null. Never guess vitamins or minerals.
- confidence: "high" for standard, well-documented foods; "medium" for typical homemade versions; "low" if unclear.
${FOOD_RULES_CORE}`;

export const ESTIMATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'food_name', 'category', 'grams', 'per_100g', 'servings', 'confidence'],
        properties: {
          index: { type: 'integer', description: 'Index of the food in the request' },
          food_name: { type: 'string', description: 'Short standard name, e.g. "Peanut chutney"' },
          category: { type: 'string' },
          grams: { type: 'number' },
          per_100g: {
            type: 'object',
            additionalProperties: false,
            required: ['protein', 'carbs', 'fat', 'fiber', 'alcohol', 'sugar', 'saturated_fat', 'sodium_mg', 'cholesterol_mg'],
            properties: {
              protein: { type: 'number' }, carbs: { type: 'number', description: 'total carbohydrate incl. fiber' }, fat: { type: 'number' },
              fiber: { type: 'number' }, alcohol: { type: 'number' },
              sugar: { anyOf: [{ type: 'number' }, { type: 'null' }] }, saturated_fat: { anyOf: [{ type: 'number' }, { type: 'null' }] },
              sodium_mg: { anyOf: [{ type: 'number' }, { type: 'null' }] }, cholesterol_mg: { anyOf: [{ type: 'number' }, { type: 'null' }] },
            },
          },
          servings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['label', 'grams'], properties: { label: { type: 'string' }, grams: { type: 'number' } } } },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
  },
};

export interface EstimateRequest { food_name: string; preparation?: string | null; quantity?: number | null; unit?: string | null; text_span?: string }

export interface EstimatedFood {
  index: number;
  food_name: string;
  category: string;
  grams: number;
  per_100g: { calories: number; protein: number; carbs: number; fat: number; fiber: number; alcohol: number; sugar: number | null; saturated_fat: number | null; sodium_mg: number | null; cholesterol_mg: number | null };
  servings: { label: string; grams: number }[];
  confidence: 'high' | 'medium' | 'low';
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const opt = (v: unknown, hi: number) => (v == null || !Number.isFinite(Number(v)) || Number(v) < 0 ? null : r2(Math.min(hi, Number(v))));

/** Validates estimates: one per requested index, possible macros, energy from macros. */
export function normalizeEstimates(raw: unknown, count: number): EstimatedFood[] {
  const list = Array.isArray((raw as { items?: unknown })?.items) ? (raw as { items: unknown[] }).items : [];
  const out = new Map<number, EstimatedFood>();
  for (const r of list.slice(0, 20)) {
    const it = (r ?? {}) as Record<string, unknown>;
    const index = Number(it.index);
    if (!Number.isInteger(index) || index < 0 || index >= count || out.has(index)) continue;
    const p = (it.per_100g ?? {}) as Record<string, unknown>;
    const m = ['protein', 'carbs', 'fat', 'fiber'].map((k) => Number(p[k]));
    const alcohol = Math.max(0, Math.min(50, Number(p.alcohol) || 0));
    if (m.some((v) => !Number.isFinite(v) || v < 0 || v > 100) || m[0] + m[1] + m[2] + alcohol > 100.5) continue;
    const grams = Number(it.grams);
    const name = String(it.food_name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!name || !(grams > 0 && grams <= 5000)) continue;
    const [protein, carbs, fat, fiber] = m;
    const calories = r2(energyFromMacros(protein, carbs, fat, alcohol));
    if (calories > 902) continue;
    out.set(index, {
      index, food_name: name, category: String(it.category ?? '').trim().slice(0, 40), grams: r2(grams),
      per_100g: { calories, protein: r2(protein), carbs: r2(carbs), fat: r2(fat), fiber: r2(Math.min(fiber, carbs)), alcohol: r2(alcohol),
        sugar: opt(p.sugar, carbs), saturated_fat: opt(p.saturated_fat, fat), sodium_mg: opt(p.sodium_mg, 40000), cholesterol_mg: opt(p.cholesterol_mg, 5000) },
      servings: (Array.isArray(it.servings) ? it.servings : []).slice(0, 3)
        .map((s) => ({ label: String((s as { label?: unknown }).label ?? '').trim().slice(0, 60), grams: Number((s as { grams?: unknown }).grams) }))
        .filter((s) => s.label && s.grams > 0 && s.grams <= 2000).map((s) => ({ ...s, grams: r2(s.grams) })),
      confidence: ['high', 'medium', 'low'].includes(String(it.confidence)) ? it.confidence as EstimatedFood['confidence'] : 'medium',
    });
  }
  return [...out.values()].sort((a, b) => a.index - b.index);
}

/** The request text for estimate: numbered foods with what the user said. */
export function estimateText(items: EstimateRequest[]): string {
  return `Foods to estimate:\n${items.map((it, i) => `${i}. ${it.food_name}${it.preparation ? ` (${it.preparation})` : ''} — the user said: """${it.text_span || it.food_name}"""${it.quantity ? ` (amount: ${it.quantity}${it.unit ? ` ${it.unit}` : ''})` : ''}`).join('\n')}`;
}
