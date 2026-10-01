// AI provider abstraction. The API keys live ONLY here, read from Edge Function secrets:
//   GEMINI_API_KEY   — Google AI Studio key
//   CLAUDE_API_KEY   — Anthropic API key (ANTHROPIC_API_KEY is also accepted)
// The browser never sees either key; it only receives the parsed result.
import Anthropic from 'npm:@anthropic-ai/sdk@0.128.0';
import { env, HttpError } from './http.ts';

export type Provider = 'gemini' | 'claude';
export type ChatTurn = { role: 'user' | 'assistant'; content: string };

export interface JsonRequest {
  system: string;
  text: string;
  image?: { mediaType: string; base64: string };
  history?: ChatTurn[];
  schema: Record<string, unknown>;
  effort?: 'low' | 'medium' | 'high';
}

const GEMINI_API_KEY = env('GEMINI_API_KEY');
const CLAUDE_API_KEY = env('CLAUDE_API_KEY', 'ANTHROPIC_API_KEY');
const GEMINI_MODEL = env('GEMINI_MODEL') || 'gemini-3.5-flash';
const GEMINI_FALLBACK_MODEL = env('GEMINI_FALLBACK_MODEL') || 'gemini-3.1-flash-lite';
const CLAUDE_MODEL = env('CLAUDE_MODEL') || 'claude-opus-5-5';

const available: Record<Provider, boolean> = { gemini: !!GEMINI_API_KEY, claude: !!CLAUDE_API_KEY };

/** Throws 503 before any work (or quota use) when no AI key secret is configured. */
export function requireAiConfigured(): void {
  if (!available.gemini && !available.claude) {
    throw new HttpError(503, 'ai_not_configured', 'AI features are not available yet.', 'No GEMINI_API_KEY or CLAUDE_API_KEY secret is set.');
  }
}

/** Provider order for a task: the configured preference first, the other as fallback. */
function providerOrder(preferred: string): Provider[] {
  const first: Provider = preferred === 'claude' ? 'claude' : 'gemini';
  const second: Provider = first === 'gemini' ? 'claude' : 'gemini';
  return [first, second].filter((p) => available[p]);
}

/**
 * Runs a JSON-producing request on the preferred provider, falling back to the other one if
 * it fails. `task` picks the preference: AI_FOOD_PROVIDER (default gemini) or
 * AI_CHAT_PROVIDER (default claude).
 */
export async function generateJson(task: 'food' | 'chat', req: JsonRequest): Promise<unknown> {
  const preferred = task === 'food' ? (env('AI_FOOD_PROVIDER') || 'gemini') : (env('AI_CHAT_PROVIDER') || 'claude');
  const order = providerOrder(preferred);
  if (!order.length) {
    throw new HttpError(503, 'ai_not_configured', 'AI features are not available yet.', 'No GEMINI_API_KEY or CLAUDE_API_KEY secret is set.');
  }
  let lastError: unknown;
  for (const p of order) {
    try {
      const out = p === 'claude' ? await claudeJson(req) : await geminiJson(req);
      return out;
    } catch (e) {
      console.error(`[ai] ${p} failed:`, e instanceof Error ? e.message : e);
      lastError = e;
    }
  }
  throw new HttpError(503, 'ai_unavailable', 'AI is unavailable right now. You can still search foods or add them manually.', lastError);
}

// ── Claude ────────────────────────────────────────────────────────────────
let anthropic: Anthropic | null = null;

async function claudeJson(req: JsonRequest): Promise<unknown> {
  anthropic ??= new Anthropic({ apiKey: CLAUDE_API_KEY, maxRetries: 2, timeout: 90_000 });
  const userContent: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (req.image) {
    userContent.push({
      type: 'image',
      source: { type: 'base64', media_type: req.image.mediaType as 'image/jpeg', data: req.image.base64 },
    });
  }
  userContent.push({ type: 'text', text: req.text });
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...(req.history ?? []).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userContent },
  ];
  // Structured output guarantees schema-valid JSON. Server-side refusal fallback is enabled
  // ("default" routes a declined request to Anthropic's recommended fallback model).
  const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    system: req.system,
    messages,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: req.effort ?? 'low', format: { type: 'json_schema', schema: req.schema } },
  };
  const resp = await anthropic.beta.messages.create(params);
  if (resp.stop_reason === 'refusal') throw new Error('Claude declined the request');
  if (resp.stop_reason === 'max_tokens') throw new Error('Claude response was truncated');
  const text = resp.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  return parseJsonLoose(text);
}

// ── Gemini ────────────────────────────────────────────────────────────────
async function geminiJson(req: JsonRequest, model = GEMINI_MODEL): Promise<unknown> {
  const parts: Record<string, unknown>[] = [];
  if (req.image) parts.push({ inline_data: { mime_type: req.image.mediaType, data: req.image.base64 } });
  parts.push({ text: req.text });
  const body = {
    system_instruction: {
      parts: [{ text: `${req.system}\n\nRespond ONLY with JSON that matches this JSON Schema:\n${JSON.stringify(req.schema)}` }],
    },
    contents: [
      ...(req.history ?? []).map((m) => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] })),
      { role: 'user', parts },
    ],
    generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 8192 },
  };
  let res: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    break;
  }
  if (!res) throw new Error('Gemini request failed');
  if (res.status === 404 && model !== GEMINI_FALLBACK_MODEL) return geminiJson(req, GEMINI_FALLBACK_MODEL);
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const cand = data?.candidates?.[0];
  const textParts = (cand?.content?.parts ?? []).filter((p: { text?: string; thought?: boolean }) => typeof p.text === 'string' && !p.thought);
  if (!textParts.length) throw new Error(`Gemini returned no content (finishReason=${cand?.finishReason})`);
  return parseJsonLoose(textParts.map((p: { text: string }) => p.text).join(''));
}

/** Parses JSON, tolerating code fences or surrounding prose. */
export function parseJsonLoose(text: string): unknown {
  const clean = text.replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(clean); } catch { /* fall through */ }
  const start = clean.search(/[[{]/);
  if (start >= 0) {
    const open = clean[start], close = open === '{' ? '}' : ']';
    let depth = 0, inStr = false, escaped = false;
    for (let i = start; i < clean.length; i++) {
      const ch = clean[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === open) depth++;
      else if (ch === close && --depth === 0) return JSON.parse(clean.slice(start, i + 1));
    }
  }
  throw new Error('AI response was not valid JSON');
}
