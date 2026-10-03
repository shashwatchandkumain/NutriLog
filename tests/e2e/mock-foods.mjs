// The Global Food Database part of the mock Supabase: seeded from the same generated data as
// production (scripts/food-data/global-foods.json) and following the same rules as the SQL in
// supabase/migrations/005_global_foods.sql (verified foods for everyone, candidates private to
// their submitters until two users agree, aliases, admin tools).
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { nameKey } from '../../js/lib/food-key.js';

const SEED = JSON.parse(readFileSync(new URL('../../scripts/food-data/global-foods.json', import.meta.url), 'utf8'));
const r2 = (v) => Math.round(v * 100) / 100;

/** pg_trgm-style similarity (shared trigrams / all trigrams). */
function trigrams(s) {
  const out = new Set();
  for (const w of String(s).split(' ').filter(Boolean)) {
    const p = `  ${w} `;
    for (let i = 0; i < p.length - 2; i++) out.add(p.slice(i, i + 3));
  }
  return out;
}
export function similarity(a, b) {
  const A = trigrams(a), B = trigrams(b);
  let n = 0;
  for (const t of A) if (B.has(t)) n++;
  return A.size + B.size - n ? n / (A.size + B.size - n) : 0;
}

export class MockFoods {
  constructor() {
    this.foods = new Map();
    this.aliases = new Map(); // alias_key → { alias, food_id }
    this.submissions = [];    // { food_id, user_id, calories }
    this.aliasVotes = [];     // { alias_key, alias, food_id, user_id }
    this.corrections = [];
    this.stats = new Map();   // day → counts
    this.admins = new Set();
    for (const f of SEED) {
      const { aliases, servings, ...food } = f;
      this.foods.set(f.id, { ...food, servings: servings.map(({ label, grams, is_default }) => ({ label, grams, is_default })), status: 'verified', version: 1, merged_into: null, confidence: 1, created_at: new Date().toISOString() });
      for (const a of aliases) this.aliases.set(a.alias_key, { alias: a.alias, food_id: f.id });
    }
  }

  visible(f, uid) {
    return f && ((f.status === 'verified' && !f.merged_into) || this.submissions.some((s) => s.food_id === f.id && s.user_id === uid) || this.admins.has(uid));
  }
  live(f) { return f && !f.merged_into && f.status !== 'rejected'; }
  json(f) {
    const { merged_into, confidence, created_at, ...out } = f; // eslint-disable-line no-unused-vars
    return { ...out, servings: f.servings.map((s) => ({ ...s })) };
  }
  byKey(key, uid) {
    const all = [...this.foods.values()].filter((f) => f.name_key === key && this.live(f) && this.visible(f, uid));
    return all.sort((a, b) => (b.status === 'verified') - (a.status === 'verified'))[0] || null;
  }

  resolve(names, uid) {
    return names.map((query) => {
      const key = nameKey(query);
      let hit = this.byKey(key, uid);
      if (hit) return { match: 'exact', food: this.json(hit), query, key, candidates: [] };
      const a = this.aliases.get(key);
      hit = a && this.foods.get(a.food_id);
      if (hit && this.live(hit) && this.visible(hit, uid)) return { match: 'alias', alias: a.alias, food: this.json(hit), query, key, candidates: [] };
      const scored = new Map();
      for (const f of this.foods.values()) if (this.live(f) && this.visible(f, uid)) scored.set(f.id, similarity(f.name_key, key));
      for (const [k, v] of this.aliases) { const f = this.foods.get(v.food_id); if (this.live(f) && this.visible(f, uid)) scored.set(f.id, Math.max(scored.get(f.id) || 0, similarity(k, key))); }
      const candidates = [...scored].filter(([, s]) => s >= 0.3).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([id, score]) => ({ score, food: this.json(this.foods.get(id)) }));
      return { query, key, candidates };
    });
  }

  search(q, uid, limit = 20) {
    const key = nameKey(q);
    if (!key) return [];
    const words = key.split(' ');
    const scored = new Map();
    const add = (id, s) => scored.set(id, Math.max(scored.get(id) || 0, s));
    for (const f of this.foods.values()) {
      if (!this.live(f) || !this.visible(f, uid)) continue;
      if (f.name_key === key) add(f.id, 3);
      else if (words.every((w) => f.name_key.includes(w))) add(f.id, 1 + similarity(f.name_key, key));
      else if (similarity(f.name_key, key) >= 0.3) add(f.id, similarity(f.name_key, key));
    }
    for (const [k, a] of this.aliases) {
      const f = this.foods.get(a.food_id);
      if (!this.live(f) || !this.visible(f, uid)) continue;
      if (k === key) add(f.id, 2.5);
      else if (words.every((w) => k.includes(w))) add(f.id, 0.9 + similarity(k, key));
    }
    return [...scored].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id, score]) => ({ ...this.json(this.foods.get(id)), score }));
  }

  bySource(sourceId, uid) {
    const f = [...this.foods.values()].find((x) => x.source_id === sourceId && this.live(x) && this.visible(x, uid));
    return f ? this.json(f) : null;
  }

  promote(f) {
    if (!['pending', 'needs_review'].includes(f.status) || f.source_type !== 'ai_assisted') return f.status;
    const subs = this.submissions.filter((s) => s.food_id === f.id);
    const spread = subs.length ? Math.max(...subs.map((s) => Math.abs(s.calories - f.calories))) / Math.max(f.calories, 1) : 0;
    if (subs.length >= 2 && spread > 0.15) f.status = 'needs_review';
    else if (f.status === 'pending' && subs.length >= 2 && (f.confidence ?? 0) >= 0.7) f.status = 'verified';
    return f.status;
  }

  /** public.submit_food — throws { code, message } like the SQL function. */
  submit(p, uid) {
    const name = String(p.name || '').replace(/\s+/g, ' ').trim();
    const key = nameKey(name);
    const fail = (message) => { throw Object.assign(new Error(message), { code: '22023' }); };
    if (name.length < 2 || name.length > 80 || !key) fail('invalid food name');
    if (/(^| )(my|mine|our|mom|moms|mommy|mummy|mother|maa|nani|dadi|grandma|granny|wife|husband|wifes|husbands)( |$)/.test(name.toLowerCase().replace(/[^a-z ]/g, ''))) return { status: 'private' };
    const type = p.source_type || 'ai_assisted';
    if (!['ai_assisted', 'external_database'].includes(type)) fail('invalid source');
    const [pr, c, ft, fib, alc] = [p.protein, p.carbs, p.fat, p.fiber ?? 0, p.alcohol ?? 0].map(Number);
    if ([pr, c, ft, fib, alc].some((v) => !Number.isFinite(v) || v < 0) || Math.max(pr, c, ft, fib) > 100 || pr + c + ft + alc > 100.5) fail('invalid nutrition values');
    const kcal = r2(4 * pr + 4 * c + 9 * ft + 7 * alc);
    const aliasHit = this.aliases.get(key);
    const existing = [...this.foods.values()].filter((f) => this.live(f) && (f.name_key === key || f.id === aliasHit?.food_id))
      .sort((a, b) => (b.status === 'verified') - (a.status === 'verified'))[0];
    if (existing) {
      if (existing.status !== 'verified') {
        if (!this.submissions.some((s) => s.food_id === existing.id && s.user_id === uid)) this.submissions.push({ food_id: existing.id, user_id: uid, calories: kcal });
        return { id: existing.id, status: this.promote(existing), existing: true };
      }
      return { id: existing.id, status: existing.status, existing: true };
    }
    const external = type === 'external_database' && /^off:\d{6,14}$/.test(String(p.source_id || ''));
    const id = randomUUID();
    this.foods.set(id, {
      id, name, name_key: key, category: p.category || null, preparation: p.preparation || null, base_unit: p.base_unit === 'ml' ? 'ml' : 'g',
      calories: kcal, protein: r2(pr), carbs: r2(c), fat: r2(ft), fiber: r2(Math.min(fib, c)), sugar: p.sugar ?? null, saturated_fat: p.saturated_fat ?? null,
      trans_fat: null, sodium_mg: p.sodium_mg ?? null, cholesterol_mg: p.cholesterol_mg ?? null, micros: {},
      source_type: type, source: external ? p.source : 'AI estimate confirmed by NutriLog users', source_id: external ? p.source_id : null, source_url: null,
      confidence: Math.max(0, Math.min(1, Number(p.confidence ?? 0.5))), status: external ? 'verified' : 'pending', version: 1, merged_into: null,
      created_at: new Date().toISOString(),
      servings: (p.servings || []).slice(0, 6).filter((s) => s.label && s.grams > 0 && s.grams <= 2000).map((s, i) => ({ label: s.label, grams: r2(s.grams), is_default: i === 0 })),
    });
    this.submissions.push({ food_id: id, user_id: uid, calories: kcal });
    return { id, status: this.foods.get(id).status, existing: false };
  }

  proposeAlias(alias, foodId, uid) {
    const key = nameKey(alias);
    const f = this.foods.get(foodId);
    if (!key || !f || f.status !== 'verified') return 'ignored';
    if (this.aliases.has(key) || [...this.foods.values()].some((x) => x.name_key === key && this.live(x))) return 'exists';
    if (!this.aliasVotes.some((v) => v.alias_key === key && v.food_id === foodId && v.user_id === uid)) this.aliasVotes.push({ alias_key: key, alias, food_id: foodId, user_id: uid });
    if (this.aliasVotes.filter((v) => v.alias_key === key && v.food_id === foodId).length >= 2) {
      this.aliases.set(key, { alias, food_id: foodId });
      this.aliasVotes = this.aliasVotes.filter((v) => v.alias_key !== key);
      return 'added';
    }
    return 'proposed';
  }

  record({ p_global: g = 0, p_external: x = 0, p_ai_items: a = 0, p_ai_calls: k = 0 }) {
    const day = new Date().toISOString().slice(0, 10);
    const s = this.stats.get(day) || { day, items: 0, global_hits: 0, external_hits: 0, ai_items: 0, ai_calls: 0, ai_calls_avoided: 0 };
    Object.assign(s, { items: s.items + g + x + a, global_hits: s.global_hits + g, external_hits: s.external_hits + x, ai_items: s.ai_items + a, ai_calls: s.ai_calls + k, ai_calls_avoided: s.ai_calls_avoided + g + x });
    this.stats.set(day, s);
  }

  overview() {
    return {
      stats: [...this.stats.values()].sort((a, b) => b.day.localeCompare(a.day)),
      totals: { foods: [...this.foods.values()].filter((f) => f.status === 'verified' && !f.merged_into).length, pending: [...this.foods.values()].filter((f) => ['pending', 'needs_review'].includes(f.status)).length },
      queue: [...this.foods.values()].filter((f) => ['pending', 'needs_review'].includes(f.status) && !f.merged_into)
        .map((f) => ({ ...this.json(f), confidence: f.confidence, created_at: f.created_at, submissions: this.submissions.filter((s) => s.food_id === f.id).length })),
      corrections: this.corrections.filter((c) => c.status === 'open').map((c) => { const f = this.foods.get(c.food_id); return { ...c, food: f.name, current: { calories: f.calories, protein: f.protein, carbs: f.carbs, fat: f.fat, fiber: f.fiber } }; }),
      aliases: [],
    };
  }

  /** Handles the food RPCs; returns undefined for anything else. */
  rpc(fn, body, uid) {
    const admin = () => { if (!this.admins.has(uid)) throw Object.assign(new Error('admins only'), { code: '42501' }); };
    switch (fn) {
      case 'resolve_foods': return this.resolve(body.p_names || [], uid);
      case 'search_foods': return this.search(body.p_query, uid, body.p_limit);
      case 'food_by_source': return this.bySource(body.p_source_id, uid);
      case 'submit_food': return this.submit(body.p_food || {}, uid);
      case 'propose_food_alias': return this.proposeAlias(body.p_alias, body.p_food, uid);
      case 'record_food_resolution': this.record(body); return null;
      case 'is_admin': return this.admins.has(uid);
      case 'admin_overview': admin(); return this.overview();
      case 'admin_set_food_status': { admin(); const f = this.foods.get(body.p_food); if (f) f.status = body.p_status; return null; }
      case 'admin_review_correction': {
        admin();
        const c = this.corrections.find((x) => x.id === body.p_id);
        if (c && body.p_approve) { const f = this.foods.get(c.food_id); Object.assign(f, c.suggested); f.calories = r2(4 * f.protein + 4 * f.carbs + 9 * f.fat); f.version++; }
        if (c) c.status = body.p_approve ? 'approved' : 'rejected';
        return null;
      }
      default: return undefined;
    }
  }
}
