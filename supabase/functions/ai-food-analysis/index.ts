// POST /functions/v1/ai-food-analysis
// Body: { mode: 'text', text } | { mode: 'image', image: { mediaType, base64 }, text? } | { mode: 'activity', text }
// Returns: { items: [...] } — foods with per-100 g values and computed totals, or activities
// with net calories burned. Requires a signed-in user; rate limited per user.
import { consumeAiQuota, HttpError, json, readJson, requireUser, serve } from '../_shared/http.ts';
import { generateJson, requireAiConfigured } from '../_shared/ai.ts';
import {
  ACTIVITY_RESULT_SCHEMA, FOOD_RESULT_SCHEMA, FOOD_RULES, normalizeActivities, normalizeFoods,
} from '../_shared/nutrition.ts';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_IMAGE_BASE64 = 3_000_000; // ≈2.2 MB image; the app sends ~150 KB JPEGs

serve(async (req) => {
  const { user, supabase } = await requireUser(req);
  requireAiConfigured();
  const body = await readJson<{ mode?: string; text?: string; image?: { mediaType?: string; base64?: string } }>(req);
  const mode = body.mode;
  const text = String(body.text ?? '').trim().slice(0, 1000);

  if (mode === 'text') {
    if (!text) throw new HttpError(400, 'empty', 'Describe what you ate.');
    await consumeAiQuota(supabase, 'food_text');
    const raw = await generateJson('food', {
      system: 'You are a precise nutrition analyst for an Indian-first calorie tracker. You estimate foods and portions from a description and return structured data only.',
      text: `Food description: """${text}"""\n\n${FOOD_RULES}`,
      schema: FOOD_RESULT_SCHEMA,
      effort: 'medium',
    });
    return json(req, { items: normalizeFoods(raw) });
  }

  if (mode === 'image') {
    const mediaType = String(body.image?.mediaType ?? '');
    const base64 = String(body.image?.base64 ?? '');
    if (!IMAGE_TYPES.has(mediaType) || !base64 || base64.length > MAX_IMAGE_BASE64 || !/^[A-Za-z0-9+/=]+$/.test(base64)) {
      throw new HttpError(400, 'bad_image', 'Please use a JPEG, PNG or WebP photo under 2 MB.');
    }
    await consumeAiQuota(supabase, 'food_image');
    const raw = await generateJson('food', {
      system: 'You are a precise nutrition analyst. You identify every food and drink visible in a photo, estimate the eaten portion from visual cues (plate ~26 cm, katori ~150 ml, spoon sizes), and return structured data only.',
      text: `Identify each food in this photo and estimate its portion.${text ? ` The user adds: """${text}"""` : ''}\n\n${FOOD_RULES}`,
      image: { mediaType, base64 },
      schema: FOOD_RESULT_SCHEMA,
      effort: 'medium',
    });
    return json(req, { items: normalizeFoods(raw) });
  }

  if (mode === 'activity') {
    if (!text) throw new HttpError(400, 'empty', 'Describe your activity.');
    await consumeAiQuota(supabase, 'activity');
    const { data: profile } = await supabase.from('profiles').select('weight_kg').eq('id', user.id).maybeSingle();
    const weightKg = Number(profile?.weight_kg) || 70;
    const raw = await generateJson('food', {
      system: 'You convert exercise descriptions into activities with durations and MET values from the Compendium of Physical Activities. Return structured data only.',
      text: `Activities: """${text}"""\nSplit into separate activities. If duration is missing assume 30 minutes. Use realistic MET values (walking 3.5, brisk walk 4.3, running 9.8, cycling 7.5, weight training 5, yoga 2.5, swimming 7, HIIT 8, dancing 5, badminton 5.5, cricket 4.8, football 7, housework 3.3). If the text is not exercise, return an empty items array.`,
      schema: ACTIVITY_RESULT_SCHEMA,
      effort: 'low',
    });
    return json(req, { items: normalizeActivities(raw, weightKg) });
  }

  throw new HttpError(400, 'bad_mode', 'Invalid request.');
});
