// In-memory stand-in for a Supabase project (Auth, PostgREST, RPC, Realtime, Edge Functions)
// used by the browser tests. It enforces per-user ownership like the real RLS policies.
import { randomUUID } from 'node:crypto';

export const MOCK_URL = 'https://mock.supabase.co';

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const OWNER = { profiles: 'id', user_preferences: 'user_id', daily_goals: 'user_id', meals: 'user_id', meal_items: 'user_id', weight_history: 'user_id', activities: 'user_id', water_logs: 'user_id' };
const PK = { profiles: ['id'], user_preferences: ['user_id'], daily_goals: ['user_id'], meals: ['id'], meal_items: ['id'], weight_history: ['id'], activities: ['id'], water_logs: ['user_id', 'log_date'] };

export class MockSupabase {
  constructor() {
    this.users = new Map();      // id → { id, email, password, user_metadata }
    this.tokens = new Map();     // access/refresh token → user id
    this.db = Object.fromEntries(Object.keys(OWNER).map((t) => [t, []]));
    this.recovery = new Map();   // user id → code
    this.calls = [];             // log of requests (for assertions)
    this.aiFailures = 0;
  }

  // ── helpers ──────────────────────────────────────────────────────────
  session(user) {
    const now = Math.floor(Date.now() / 1000);
    const access = `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ sub: user.id, role: 'authenticated', email: user.email, exp: now + 3600, iat: now, aud: 'authenticated', is_anonymous: false })}.sig`;
    const refresh = randomUUID();
    this.tokens.set(access, user.id);
    this.tokens.set(refresh, user.id);
    return { access_token: access, token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: refresh, user: this.publicUser(user) };
  }
  publicUser(u) {
    return { id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, email_confirmed_at: new Date().toISOString(), phone: '', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: u.user_metadata || {}, identities: [{ id: u.id, provider: 'email' }], created_at: u.created_at, updated_at: new Date().toISOString(), is_anonymous: false };
  }
  userFrom(headers) {
    const token = (headers.authorization || '').replace(/^Bearer\s+/i, '');
    const id = this.tokens.get(token);
    return id ? this.users.get(id) : null;
  }
  createDefaults(uid) {
    const now = new Date().toISOString();
    this.db.profiles.push({ id: uid, display_name: null, age: null, sex: null, height_cm: null, weight_kg: null, start_weight_kg: null, target_weight_kg: null, target_date: null, goal: 'maintain', activity_level: 'sedentary', daily_steps: null, workouts_per_week: null, diet_type: null, macro_style: 'balanced', allergies: [], onboarding_completed: false, created_at: now, updated_at: now });
    this.db.user_preferences.push({ user_id: uid, weight_unit: 'kg', height_unit: 'cm', theme: 'system', water_goal: 8, exercise_mode: 'included', reminders_enabled: false, reminder_time: '20:00:00', ai_provider: 'gemini', updated_at: now });
    this.db.daily_goals.push({ user_id: uid, calories: null, protein_g: null, carbs_g: null, fat_g: null, fiber_g: null, is_custom: false, updated_at: now });
  }
  rows(table, uid) { return this.db[table].filter((r) => r[OWNER[table]] === uid); }
  syncProfileWeight(uid) {
    const latest = this.rows('weight_history', uid).sort((a, b) => b.recorded_on.localeCompare(a.recorded_on))[0];
    const p = this.db.profiles.find((x) => x.id === uid);
    if (latest && p) p.weight_kg = latest.weight_kg;
    for (const a of this.rows('activities', uid)) this.computeActivity(a);
  }
  /** public.weight_on() */
  weightOn(uid, date) {
    const w = this.rows('weight_history', uid).sort((a, b) => a.recorded_on.localeCompare(b.recorded_on));
    const on = [...w].reverse().find((x) => x.recorded_on <= date) || w[0];
    return on ? Number(on.weight_kg) : Number(this.db.profiles.find((x) => x.id === uid)?.weight_kg) || null;
  }
  /** The activities_net_calories trigger. */
  computeActivity(a) {
    if (a.met == null) { a.weight_kg = null; return; }
    const w = this.weightOn(a.user_id, a.activity_date);
    if (!w) return;
    a.weight_kg = w;
    a.calories_burned = Math.round(Math.max(0, Number(a.met) - 1) * w * Number(a.duration_min) / 60 * 100) / 100;
  }

  // ── request entry point ──────────────────────────────────────────────
  async handle(route) {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const headers = req.headers();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    let body = null;
    try { body = req.postData() ? JSON.parse(req.postData()) : null; } catch { body = req.postData(); }
    this.calls.push({ method, path: url.pathname, search: url.search, body });
    const reply = (status, json, extra = {}) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json', ...extra }, body: json === undefined ? '' : JSON.stringify(json) });
    try {
      if (url.pathname.startsWith('/auth/v1/')) return this.auth(url, method, headers, body, reply);
      if (url.pathname.startsWith('/rest/v1/rpc/')) return this.rpc(url.pathname.slice(13), headers, body, reply);
      if (url.pathname.startsWith('/rest/v1/')) return this.rest(url, method, headers, body, reply);
      if (url.pathname.startsWith('/functions/v1/')) return this.fn(url.pathname.slice(14), headers, body, reply);
      return reply(404, { message: 'not found' });
    } catch (e) {
      console.error('[mock]', e);
      return reply(500, { message: String(e) });
    }
  }

  auth(url, method, headers, body, reply) {
    const p = url.pathname.slice(9);
    if (p === 'signup' && method === 'POST') {
      if ([...this.users.values()].some((u) => u.email === body.email)) return reply(422, { code: 'user_already_exists', msg: 'User already registered', error_code: 'user_already_exists' });
      const u = { id: randomUUID(), email: body.email, password: body.password, user_metadata: body.data || {}, created_at: new Date().toISOString() };
      this.users.set(u.id, u);
      this.createDefaults(u.id);
      return reply(200, this.session(u));
    }
    if (p === 'token') {
      const grant = url.searchParams.get('grant_type');
      if (grant === 'password') {
        const u = [...this.users.values()].find((x) => x.email === body.email && x.password === body.password);
        if (!u) return reply(400, { code: 'invalid_credentials', error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
        return reply(200, this.session(u));
      }
      if (grant === 'refresh_token') {
        const id = this.tokens.get(body.refresh_token);
        if (!id || !this.users.get(id)) return reply(400, { code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
        return reply(200, this.session(this.users.get(id)));
      }
    }
    if (p === 'user') {
      const u = this.userFrom(headers);
      if (!u) return reply(401, { code: 'bad_jwt', msg: 'invalid JWT' });
      if (method === 'PUT') {
        if (body.password) u.password = body.password;
        if (body.data) u.user_metadata = { ...u.user_metadata, ...body.data };
      }
      return reply(200, this.publicUser(u));
    }
    if (p === 'logout') return reply(204);
    if (p === 'recover' || p === 'otp' || p === 'resend') return reply(200, {});
    return reply(404, { msg: `unhandled auth ${p}` });
  }

  // PostgREST subset: eq/gte/lte filters, order, offset/limit, upsert, patch, delete.
  rest(url, method, headers, body, reply) {
    const table = url.pathname.slice(9);
    if (!OWNER[table]) return reply(404, { code: '42P01', message: `relation "${table}" does not exist` });
    const u = this.userFrom(headers);
    if (!u) return reply(401, { code: '42501', message: 'permission denied' });
    const owner = OWNER[table];
    const filters = [];
    let order = null, offset = 0, limit = Infinity;
    for (const [k, v] of url.searchParams) {
      if (k === 'select' || k === 'columns' || k === 'on_conflict') continue;
      if (k === 'order') { order = v; continue; }
      if (k === 'offset') { offset = Number(v); continue; }
      if (k === 'limit') { limit = Number(v); continue; }
      const [op, ...rest] = v.split('.');
      filters.push([k, op, rest.join('.')]);
    }
    const match = (r) => r[owner] === u.id && filters.every(([k, op, val]) => {
      const x = r[k] == null ? null : String(r[k]);
      if (op === 'eq') return x === val;
      if (op === 'gte') return x >= val;
      if (op === 'lte') return x <= val;
      return true;
    });
    const prefer = headers.prefer || '';
    const wantsObject = (headers.accept || '').includes('vnd.pgrst.object');
    const out = (rows, status = 200) => {
      if (wantsObject) {
        if (rows.length !== 1) return reply(406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `The result contains ${rows.length} rows` });
        return reply(status, rows[0]);
      }
      return reply(status, prefer.includes('return=minimal') && method !== 'GET' ? undefined : rows);
    };
    if (method === 'GET' || method === 'HEAD') {
      let rows = this.db[table].filter(match);
      if (order) {
        const specs = order.split(',').map((s) => s.split('.'));
        rows = [...rows].sort((a, b) => { for (const [c, dir] of specs) { const r = String(a[c] ?? '').localeCompare(String(b[c] ?? '')); if (r) return dir === 'desc' ? -r : r; } return 0; });
      }
      return out(rows.slice(offset, offset + limit));
    }
    if (method === 'POST') {
      const list = Array.isArray(body) ? body : [body];
      const conflict = (url.searchParams.get('on_conflict') || PK[table].join(',')).split(',');
      const ignore = prefer.includes('ignore-duplicates');
      const merge = prefer.includes('merge-duplicates');
      const result = [];
      for (const raw of list) {
        const row = { ...raw };
        row[owner] ??= u.id;
        if (row[owner] !== u.id) return reply(403, { code: '42501', message: 'new row violates row-level security policy' });
        if (PK[table].includes('id')) row.id ??= randomUUID();
        row.created_at ??= new Date().toISOString();
        const existing = this.db[table].find((r) => conflict.every((c) => String(r[c]) === String(row[c])));
        if (existing) {
          if (ignore) continue;
          if (!merge) return reply(409, { code: '23505', message: 'duplicate key value violates unique constraint' });
          Object.assign(existing, row, { updated_at: new Date().toISOString() });
          result.push(existing);
        } else {
          this.db[table].push(row);
          result.push(row);
        }
      }
      if (table === 'activities') result.forEach((a) => this.computeActivity(a));
      if (table === 'weight_history') this.syncProfileWeight(u.id);
      return out(result, 201);
    }
    if (method === 'PATCH') {
      const rows = this.db[table].filter(match);
      for (const r of rows) Object.assign(r, body, { updated_at: new Date().toISOString() });
      if (table === 'activities') rows.forEach((a) => this.computeActivity(a));
      if (table === 'weight_history') this.syncProfileWeight(u.id);
      return out(rows);
    }
    if (method === 'DELETE') {
      const rows = this.db[table].filter(match);
      this.db[table] = this.db[table].filter((r) => !rows.includes(r));
      if (table === 'weight_history') this.syncProfileWeight(u.id);
      return out(rows);
    }
    return reply(405, { message: 'method' });
  }

  rpc(fn, headers, body, reply) {
    const u = this.userFrom(headers);
    if (!u) return reply(401, { code: '42501', message: 'permission denied' });
    if (fn === 'log_meal_items') {
      let meal = this.db.meals.find((m) => m.user_id === u.id && m.meal_date === body.p_meal_date && m.meal_type === body.p_meal_type);
      if (!meal) { meal = { id: randomUUID(), user_id: u.id, meal_date: body.p_meal_date, meal_type: body.p_meal_type, created_at: new Date().toISOString() }; this.db.meals.push(meal); }
      const inserted = [];
      for (const x of body.p_items) {
        if (this.db.meal_items.some((i) => i.id === x.id)) continue; // ON CONFLICT DO NOTHING
        const row = { ...x, id: x.id || randomUUID(), meal_id: meal.id, user_id: u.id, meal_date: meal.meal_date, meal_type: meal.meal_type, created_at: new Date().toISOString() };
        for (const k of ['calories', 'protein', 'carbs', 'fat', 'fiber']) row[k] = Math.round(Number(row[k] || 0) * 100) / 100;
        this.db.meal_items.push(row); inserted.push(row);
      }
      return reply(200, inserted);
    }
    if (fn === 'update_meal_item') {
      const it = this.db.meal_items.find((i) => i.id === body.p_id && i.user_id === u.id);
      if (!it) return reply(404, { code: 'P0002', message: 'item not found' });
      Object.assign(it, body.p_patch);
      if (body.p_meal_type) it.meal_type = body.p_meal_type;
      return reply(200, it);
    }
    if (fn === 'logged_dates') {
      const dates = [...new Set(this.rows('meal_items', u.id).map((i) => i.meal_date))].sort();
      return reply(200, dates.map((d) => ({ meal_date: d })));
    }
    if (fn === 'recovery_code_status') return reply(200, { has_code: this.recovery.has(u.id), created_at: this.recovery.has(u.id) ? new Date().toISOString() : null });
    if (fn === 'claim_legacy_data') return reply(200, { meal_items: 0, weights: 0, activities: 0 });
    return reply(404, { code: 'PGRST202', message: `Could not find the function public.${fn}` });
  }

  fn(name, headers, body, reply) {
    const u = this.userFrom(headers);
    if (name === 'ai-food-analysis') {
      if (!u) return reply(401, { error: { code: 'unauthorized', message: 'Please log in again.' } });
      if (this.aiFailures > 0) { this.aiFailures--; return reply(503, { error: { code: 'ai_unavailable', message: 'AI is unavailable right now. Please try again, or add the food manually.' } }); }
      this.lastProvider = body.provider;
      const provider = body.provider === 'claude' ? 'claude' : 'gemini';
      if (body.mode === 'activity') return reply(200, { items: [{ name: 'Badminton', duration_min: 45, met: 5.5, calories_burned: Math.round(4.5 * (Number(body.weight_kg) || 70) * 0.75 * 100) / 100 }], provider });
      // Like the real function: energy is always computed from the macros.
      const item = (food_name, grams, m) => {
        const per = { ...m, calories: m.protein * 4 + m.carbs * 4 + m.fat * 9 };
        return { food_name, portion_description: `${grams} g`, grams, per_100g: per, confidence: 'high',
          ...Object.fromEntries(Object.entries(per).map(([k, v]) => [k, Math.round(v * grams) / 100])) };
      };
      return reply(200, { items: [
        item('Dal tadka', 150, { protein: 6, carbs: 15, fat: 5, fiber: 4 }),
        item('Jeera rice', 158, { protein: 3, carbs: 28, fat: 3, fiber: 1 }),
      ], provider });
    }
    if (name === 'ai-chat') {
      if (!u) return reply(401, { error: { code: 'unauthorized', message: 'Please log in again.' } });
      return reply(200, { reply: 'You are doing well today. Add some protein at dinner.', foods: [], provider: body.provider === 'claude' ? 'claude' : 'gemini' });
    }
    if (name === 'account-recovery') {
      if (body.action === 'generate') { if (!u) return reply(401, {}); const code = 'NUTRI-AB2C-DE3F'; this.recovery.set(u.id, code); return reply(200, { code }); }
      if (body.action === 'recover') {
        const user = [...this.users.values()].find((x) => x.email === body.email);
        if (!user || this.recovery.get(user.id) !== body.code) return reply(400, { error: { code: 'invalid_code', message: "That email and recovery code don't match." } });
        user.password = body.password; this.recovery.delete(user.id);
        return reply(200, { ok: true });
      }
    }
    if (name === 'delete-account') {
      if (!u) return reply(401, {});
      for (const t of Object.keys(this.db)) this.db[t] = this.db[t].filter((r) => r[OWNER[t]] !== u.id);
      this.users.delete(u.id);
      for (const [k, v] of this.tokens) if (v === u.id) this.tokens.delete(k);
      return reply(200, { ok: true });
    }
    return reply(404, { error: { code: 'not_found', message: 'Not found' } });
  }

  /** Minimal Phoenix channel server so the realtime client connects cleanly. */
  realtime(ws) {
    ws.onMessage((raw) => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      const arr = Array.isArray(msg);
      const [joinRef, ref, topic, event, payload] = arr ? msg : [msg.join_ref, msg.ref, msg.topic, msg.event, msg.payload];
      let response = {};
      if (event === 'phx_join') {
        const pc = payload?.config?.postgres_changes || [];
        response = { postgres_changes: pc.map((b, i) => ({ ...b, id: i + 1 })) };
      }
      if (['phx_join', 'heartbeat', 'access_token', 'phx_leave'].includes(event)) {
        const reply = { status: 'ok', response };
        ws.send(JSON.stringify(arr ? [joinRef, ref, topic, 'phx_reply', reply] : { topic, event: 'phx_reply', payload: reply, ref, join_ref: joinRef }));
      }
    });
  }
}
