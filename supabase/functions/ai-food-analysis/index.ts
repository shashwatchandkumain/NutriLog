// POST /functions/v1/ai-food-analysis
// Body: { mode: 'text', text, provider? } | { mode: 'image', image: { mediaType, base64 }, text?, provider? }
//     | { mode: 'activity', text, weight_kg?, provider? }
// provider: 'gemini' | 'claude' — the model the user picked (the other one is a fallback).
// Returns: { items: [...], provider } — foods with per-100 g values and computed totals, or
// activities with MET and net calories burned. Requires a signed-in user; rate limited per user.
import { consumeAiQuota, HttpError, json, readJson, requireUser, serve } from '../_shared/http.ts';
import { generateJson, pickProvider, requireAiConfigured } from '../_shared/ai.ts';
import { ESTIMATE_SCHEMA, ESTIMATE_SYSTEM, estimateText, normalizeEstimates, PARSE_SCHEMA, PARSE_SYSTEM, validateParsed } from '../_shared/meal-parse.ts';
import {
  ACTIVITY_RESULT_SCHEMA, FOOD_RESULT_SCHEMA, FOOD_RULES, normalizeActivities, normalizeFoods,
} from '../_shared/nutrition.ts';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_IMAGE_BASE64 = 3_000_000; // ≈2.2 MB image; the app sends ~150 KB JPEGs

const FOOD_SYSTEM = `You are a precise nutrition analyst for an Indian-first calorie tracker. You identify foods and drinks and their eaten portions, and return structured data only.

${FOOD_RULES}`;

const PHOTO_SYSTEM = `${FOOD_SYSTEM}

For photos: identify every food and drink visible and estimate each eaten portion from visual cues (dinner plate ≈ 26 cm, katori ≈ 150 ml, steel glass ≈ 250 ml, tablespoon ≈ 15 ml).
Only list what you can actually see (or what the user's note names). Never add foods that are usually served together but aren't visible. Name the preparation you can see ("boiled egg", "fried egg").`;

const ACTIVITY_SYSTEM = `You convert exercise descriptions into activities with whole-minute durations and MET values, and return structured data only.
- Split into separate activities. If a duration is missing, assume 30 minutes.
- Use the Compendium of Physical Activities (2024): walking 3.5, brisk walk 4.3, running 9.8, cycling 7.5, weight training 5, yoga 2.5, swimming 7, HIIT 8, dancing 5, badminton 5.5, cricket 4.8, football 7, stairs 8, housework 3.3.
- Treadmill with a speed (convert mph to km/h) uses the ACSM equations, with S = speed in m/min and G = incline as a fraction:
  walking (under 7 km/h): VO2 = 3.5 + 0.1·S + 1.8·S·G; running (7 km/h or faster): VO2 = 3.5 + 0.2·S + 0.9·S·G; MET = VO2 / 3.5.
- Give MET with two decimals. If the text is not exercise, return an empty items array.`;

serve(async (req) => {
  const { user, supabase } = await requireUser(req);
  requireAiConfigured();
  const body = await readJson<{ mode?: string; text?: string; provider?: string; weight_kg?: number; image?: { mediaType?: string; base64?: string };
    items?: { food_name?: unknown; preparation?: unknown; quantity?: unknown; unit?: unknown; text_span?: unknown }[] }>(req);
  const mode = body.mode;
  const text = String(body.text ?? '').trim().slice(0, 1000);
  const provider = pickProvider(body.provider, 'food');

  if (mode === 'text') {
    if (!text) throw new HttpError(400, 'empty', 'Describe what you ate.');
    await consumeAiQuota(supabase, 'food_text');
    const { data, provider: used } = await generateJson(provider, {
      system: FOOD_SYSTEM,
      text: `Food description: """${text}"""`,
      schema: FOOD_RESULT_SCHEMA,
      effort: 'medium',
    });
    return json(req, { items: normalizeFoods(data), provider: used });
  }

  // Step 1 of the database-first flow: understand the meal (no nutrition).
  if (mode === 'parse') {
    if (!text) throw new HttpError(400, 'empty', 'Describe what you ate.');
    await consumeAiQuota(supabase, 'food_parse');
    const { data, provider: used } = await generateJson(provider, {
      system: PARSE_SYSTEM,
      text: `User text: """${text}"""`,
      schema: PARSE_SCHEMA,
      effort: 'low',
    });
    return json(req, { items: validateParsed(data, text), provider: used });
  }

  // Step 2: nutrition only for the foods NutriLog's database doesn't know.
  if (mode === 'estimate') {
    const list = (Array.isArray(body.items) ? body.items : []).slice(0, 10)
      .map((it) => ({ food_name: String(it?.food_name ?? '').trim().slice(0, 80), preparation: it?.preparation ? String(it.preparation).slice(0, 40) : null,
        quantity: Number(it?.quantity) > 0 ? Number(it.quantity) : null, unit: it?.unit ? String(it.unit).slice(0, 30) : null,
        text_span: String(it?.text_span ?? '').slice(0, 120) }))
      .filter((it) => it.food_name);
    if (!list.length) throw new HttpError(400, 'empty', 'Nothing to estimate.');
    await consumeAiQuota(supabase, 'food_estimate');
    const { data, provider: used } = await generateJson(provider, {
      system: ESTIMATE_SYSTEM,
      text: estimateText(list),
      schema: ESTIMATE_SCHEMA,
      effort: 'medium',
    });
    return json(req, { items: normalizeEstimates(data, list.length), provider: used });
  }

  if (mode === 'image') {
    const mediaType = String(body.image?.mediaType ?? '');
    const base64 = String(body.image?.base64 ?? '');
    if (!IMAGE_TYPES.has(mediaType) || !base64 || base64.length > MAX_IMAGE_BASE64 || !/^[A-Za-z0-9+/=]+$/.test(base64)) {
      throw new HttpError(400, 'bad_image', 'Please use a JPEG, PNG or WebP photo under 2 MB.');
    }
    await consumeAiQuota(supabase, 'food_image');
    const { data, provider: used } = await generateJson(provider, {
      system: PHOTO_SYSTEM,
      text: `Identify each food in this photo and estimate its portion.${text ? ` The user adds: """${text}"""` : ''}`,
      image: { mediaType, base64 },
      schema: FOOD_RESULT_SCHEMA,
      effort: 'medium',
    });
    return json(req, { items: normalizeFoods(data), provider: used });
  }

  if (mode === 'activity') {
    if (!text) throw new HttpError(400, 'empty', 'Describe your activity.');
    await consumeAiQuota(supabase, 'activity');
    // The app sends the user's weight on the activity's date; otherwise use the profile weight.
    let weightKg = Number(body.weight_kg);
    if (!(weightKg >= 20 && weightKg <= 400)) {
      const { data: profile } = await supabase.from('profiles').select('weight_kg').eq('id', user.id).maybeSingle();
      weightKg = Number(profile?.weight_kg) || 70;
    }
    const { data, provider: used } = await generateJson(provider, {
      system: ACTIVITY_SYSTEM,
      text: `Activities: """${text}"""`,
      schema: ACTIVITY_RESULT_SCHEMA,
      effort: 'low',
    });
    return json(req, { items: normalizeActivities(data, weightKg), provider: used });
  }

  throw new HttpError(400, 'bad_mode', 'Invalid request.');
});
