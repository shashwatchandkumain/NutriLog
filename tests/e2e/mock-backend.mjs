// In-memory stand-in for a Supabase project (Auth, PostgREST, RPC, Realtime, Edge Functions)
// used by the browser tests. It enforces per-user ownership like the real RLS policies.
import { randomUUID } from 'node:crypto';
import { MockFoods } from './mock-foods.mjs';
import { MockBilling } from './mock-billing.mjs';

export const MOCK_URL = 'https://mock.supabase.co';

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const OWNER = { profiles: 'id', user_preferences: 'user_id', daily_goals: 'user_id', meals: 'user_id', meal_items: 'user_id', weight_history: 'user_id', activities: 'user_id', water_logs: 'user_id', favorite_foods: 'user_id', food_corrections: 'user_id', ai_reports: 'user_id' };
const PK = { profiles: ['id'], user_preferences: ['user_id'], daily_goals: ['user_id'], meals: ['id'], meal_items: ['id'], weight_history: ['id'], activities: ['id'], water_logs: ['user_id', 'log_date'], favorite_foods: ['id'], food_corrections: ['id'], ai_reports: ['id'] };
// Unique constraints besides the primary key (like the real schema).
const UNIQUE = { favorite_foods: ['user_id', 'food_name', 'unit'], weight_history: ['user_id', 'recorded_on'] };

export class MockSupabase {
  constructor() {
    this.users = new Map();      // id → { id, email, password, user_metadata }
    this.tokens = new Map();     // access/refresh token → user id
    this.db = Object.fromEntries(Object.keys(OWNER).map((t) => [t, []]));
    this.recovery = new Map();   // user id → code
    this.calls = [];             // log of requests (for assertions)
    this.aiFailures = 0;
    this.foodDb = new MockFoods();
    this.billing = new MockBilling(this);
    this.otps = new Map();      // phone → code (WhatsApp OTP stand-in)
    this.db.food_corrections = this.foodDb.corrections; // the same list, so admin tools see reports
    this.ai = [];               // every AI request: { mode, body } — to check what reached AI
  }

  // ── helpers ──────────────────────────────────────────────────────────
  /** A session for `user`; `ttl` (seconds) is longer for tests that move the browser's clock. */
  session(user, ttl = 3600) {
    const now = Math.floor(Date.now() / 1000);
    const access = `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ sub: user.id, role: 'authenticated', email: user.email, exp: now + ttl, iat: now, aud: 'authenticated', is_anonymous: false })}.sig`;
    const refresh = randomUUID();
    this.tokens.set(access, user.id);
    this.tokens.set(refresh, user.id);
    return { access_token: access, token_type: 'bearer', expires_in: ttl, expires_at: now + ttl, refresh_token: refresh, user: this.publicUser(user) };
  }
  publicUser(u) {
    return { id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, email_confirmed_at: new Date().toISOString(), phone: u.phone || '', phone_confirmed_at: u.phone_confirmed ? new Date().toISOString() : null, app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: u.user_metadata || {}, identities: [{ id: u.id, provider: 'email' }], created_at: u.created_at, updated_at: new Date().toISOString(), is_anonymous: false };
  }
  userFrom(headers) {
    const token = (headers.authorization || '').replace(/^Bearer\s+/i, '');
    const id = this.tokens.get(token);
    return id ? this.users.get(id) : null;
  }
  createDefaults(uid) {
    const now = new Date().toISOString();
    this.db.profiles.push({ id: uid, display_name: null, age: null, sex: null, height_cm: null, weight_kg: null, start_weight_kg: null, target_weight_kg: null, target_date: null, goal: 'maintain', activity_level: 'sedentary', daily_steps: null, workouts_per_week: null, diet_type: null, macro_style: 'balanced', allergies: [], onboarding_completed: false, phone: null, phone_verified: false, created_at: now, updated_at: now });
    this.db.user_preferences.push({ user_id: uid, weight_unit: 'kg', height_unit: 'cm', theme: 'system', water_goal: 8, water_goal_ml: 2000, exercise_mode: 'included', reminders_enabled: false, reminder_time: '20:00:00', ai_provider: 'gemini', updated_at: now });
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
  /** BEFORE INSERT/UPDATE triggers from migration 004: water ml ↔ glasses stay in sync. */
  beforeWrite(table, row, old) {
    if (table === 'profiles') {
      const u = this.users.get(row.id);
      row.phone_verified = !!(row.phone && u?.phone_confirmed && `+${u.phone}` === row.phone); // like profiles_phone_guard
    }
    if (table === 'water_logs') {
      row.ml = Number(row.ml ?? 0); row.glasses = Number(row.glasses ?? 0);
      if (!old) { if (row.ml === 0 && row.glasses > 0) row.ml = row.glasses * 250; }
      else if (row.ml === Number(old.ml) && row.glasses !== Number(old.glasses)) row.ml = row.glasses * 250;
      row.glasses = Math.min(40, Math.round(row.ml / 250));
    }
    if (table === 'user_preferences') {
      if (old && row.water_goal !== old.water_goal && row.water_goal_ml === old.water_goal_ml) row.water_goal_ml = Math.min(10000, row.water_goal * 250);
      row.water_goal = Math.max(1, Math.min(30, Math.round(row.water_goal_ml / 250)));
    }
    return row;
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
        const u = [...this.users.values()].find((x) => x.password === body.password &&
          (body.phone ? x.phone_confirmed && `+${x.phone}` === body.phone.replace(/^(?!\+)/, '+') : x.email === body.email));
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
        if (body.phone) {
          if (!this.billing.phoneVerification) return reply(400, { code: 'phone_provider_disabled', msg: 'Phone logins are disabled' });
          const digits = body.phone.replace(/\D/g, '');
          if ([...this.users.values()].some((x) => x !== u && x.phone === digits && x.phone_confirmed)) return reply(422, { code: 'phone_exists', msg: 'A user with this phone number has already been registered' });
          u.phone_change = digits;
          this.otps.set(digits, '246810'); // "sent on WhatsApp"
        }
      }
      return reply(200, this.publicUser(u));
    }
    if (p === 'verify' && method === 'POST' && body.type === 'phone_change') {
      // Like GoTrue: found by the pending number, no session needed.
      const digits = String(body.phone || '').replace(/\D/g, '');
      const u = [...this.users.values()].find((x) => x.phone_change === digits);
      if (!u || this.otps.get(digits) !== body.token) return reply(403, { code: 'otp_expired', msg: 'Token has expired or is invalid' });
      u.phone = digits; u.phone_confirmed = true; u.phone_change = null; this.otps.delete(digits);
      const prof = this.db.profiles.find((x) => x.id === u.id);
      if (prof) Object.assign(prof, this.beforeWrite('profiles', { ...prof, phone: `+${digits}` }, { ...prof })); // on_auth_phone_confirmed
      return reply(200, this.session(u));
    }
    if (p === 'logout') return reply(204);
    if (p === 'recover' || p === 'otp' || p === 'resend') return reply(200, {});
    return reply(404, { msg: `unhandled auth ${p}` });
  }

  // PostgREST subset: eq/gte/lte filters, order, offset/limit, upsert, patch, delete.
  rest(url, method, headers, body, reply) {
    const table = url.pathname.slice(9);
    if (table === 'foods' && method === 'GET') {
      const user = this.userFrom(headers);
      if (!user) return reply(401, { code: '42501', message: 'permission denied' });
      const id = (url.searchParams.get('id') || '').replace(/^eq\./, '');
      const f = this.foodDb.foods.get(id);
      const rows = f && this.foodDb.visible(f, user.id) ? [this.foodDb.json(f)] : [];
      return reply(200, (headers.accept || '').includes('vnd.pgrst.object') ? rows[0] ?? null : rows);
    }
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
        if (table === 'food_corrections') row.status ??= 'open';
        row.created_at ??= new Date().toISOString();
        const existing = this.db[table].find((r) => r[owner] === u.id && conflict.every((c) => String(r[c]) === String(row[c])));
        if (existing) {
          if (ignore) continue;
          if (!merge) return reply(409, { code: '23505', message: 'duplicate key value violates unique constraint' });
          Object.assign(existing, this.beforeWrite(table, { ...existing, ...row, updated_at: new Date().toISOString() }, existing));
          result.push(existing);
        } else {
          const uniq = UNIQUE[table];
          if (uniq && this.db[table].some((r) => uniq.every((c) => String(r[c]) === String(row[c])))) {
            if (ignore) continue;
            return reply(409, { code: '23505', message: 'duplicate key value violates unique constraint' });
          }
          this.db[table].push(this.beforeWrite(table, row, null));
          result.push(row);
        }
      }
      if (table === 'activities') result.forEach((a) => this.computeActivity(a));
      if (table === 'weight_history') this.syncProfileWeight(u.id);
      return out(result, 201);
    }
    if (method === 'PATCH') {
      const rows = this.db[table].filter(match);
      for (const r of rows) Object.assign(r, this.beforeWrite(table, { ...r, ...body, updated_at: new Date().toISOString() }, { ...r }));
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
    if (this.rejectRpc === fn) { // a test asks for one permanent rejection (e.g. invalid data)
      this.rejectRpc = null;
      return reply(400, { code: '23514', message: 'new row for relation "meal_items" violates check constraint', details: null, hint: null });
    }
    if (fn === 'log_meal_items') {
      let meal = this.db.meals.find((m) => m.user_id === u.id && m.meal_date === body.p_meal_date && m.meal_type === body.p_meal_type);
      if (!meal) { meal = { id: randomUUID(), user_id: u.id, meal_date: body.p_meal_date, meal_type: body.p_meal_type, created_at: new Date().toISOString() }; this.db.meals.push(meal); }
      const inserted = [];
      for (const x of body.p_items) {
        if (this.db.meal_items.some((i) => i.id === x.id)) continue; // ON CONFLICT DO NOTHING
        const ref = this.foodDb.foods.get(x.food_ref);
        const row = { ...x, id: x.id || randomUUID(), meal_id: meal.id, user_id: u.id, meal_date: meal.meal_date, meal_type: meal.meal_type, created_at: new Date().toISOString(),
          food_ref: ref && this.foodDb.visible(ref, u.id) ? ref.id : null, food_version: ref && this.foodDb.visible(ref, u.id) ? ref.version : null,
          micros: x.micros && typeof x.micros === 'object' ? x.micros : null };
        for (const k of ['calories', 'protein', 'carbs', 'fat', 'fiber']) row[k] = Math.round(Number(row[k] || 0) * 100) / 100;
        this.db.meal_items.push(row); inserted.push(row);
      }
      return reply(200, inserted);
    }
    if (fn === 'update_meal_item') {
      const it = this.db.meal_items.find((i) => i.id === body.p_id && i.user_id === u.id);
      if (!it) return reply(404, { code: 'P0002', message: 'item not found' });
      const { food_name: name, ...patch } = body.p_patch || {};
      for (const k of ['calories', 'protein', 'carbs', 'fat', 'fiber']) if (patch[k] != null) patch[k] = Math.round(Number(patch[k]) * 100) / 100;
      Object.assign(it, patch);
      if (typeof name === 'string' && name.trim()) it.food_name = name.trim().slice(0, 200); // blank names are ignored
      if (body.p_meal_type) it.meal_type = body.p_meal_type;
      return reply(200, it);
    }
    if (fn === 'logged_dates') {
      const dates = [...new Set(this.rows('meal_items', u.id).map((i) => i.meal_date))].sort();
      return reply(200, dates.map((d) => ({ meal_date: d })));
    }
    try {
      const bill = this.billing.rpc(fn, body || {}, u.id);
      if (bill !== undefined) return reply(200, bill);
      const res = this.foodDb.rpc(fn, body || {}, u.id);
      if (res !== undefined) return reply(200, res);
    } catch (e) {
      return reply(e.code === '42501' ? 403 : 400, { code: e.code || 'P0001', message: e.message });
    }
    if (fn === 'recovery_code_status') return reply(200, { has_code: this.recovery.has(u.id), created_at: this.recovery.has(u.id) ? new Date().toISOString() : null });
    if (fn === 'claim_legacy_data') return reply(200, { meal_items: 0, weights: 0, activities: 0 });
    return reply(404, { code: 'PGRST202', message: `Could not find the function public.${fn}` });
  }

  fn(name, headers, body, reply) {
    const u = this.userFrom(headers);
    if (name === 'ai-food-analysis') {
      if (!u) return reply(401, { error: { code: 'unauthorized', message: 'Please log in again.' } });
      const spend = this.billing.spend(u.id, { text: 'food_text', image: 'food_image', parse: 'food_parse', estimate: 'food_estimate', activity: 'activity' }[body.mode]);
      if (!spend.ok) return reply(402, { error: { code: 'no_credits', message: "You've used your AI credits for now. Upgrade for more — foods from the NutriLog database still log for free." } });
      if (this.aiFailures > 0) { this.aiFailures--; spend.refund(); return reply(503, { error: { code: 'ai_unavailable', message: 'AI is unavailable right now. Please try again, or add the food manually.' } }); }
      this.lastProvider = body.provider;
      const provider = body.provider === 'claude' && spend.features.claude ? 'claude' : 'gemini';
      this.ai.push({ mode: body.mode, body });
      if (body.mode === 'parse') return reply(200, { items: this.mockParse(body.text), provider });
      if (body.mode === 'estimate') return reply(200, { items: (body.items || []).map((it, index) => this.mockEstimate(it, index)), provider });
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
      const feature = { weekly_report: 'weekly_report', plan: 'meal_plan' }[body.mode];
      if (feature && !this.billing.entitlement(u.id).features[feature]) {
        return reply(403, { error: { code: 'plan_required', message: `This is a ${feature === 'meal_plan' ? 'Pro AI' : 'Pro'} feature. Upgrade to use it.` } });
      }
      const action = body.mode === 'plan' ? (body.days === 7 ? 'meal_plan_week' : 'meal_plan_day') : body.mode === 'meal_plan' ? 'suggest_meal' : body.mode || 'chat';
      const spend = this.billing.spend(u.id, action);
      if (!spend.ok) return reply(402, { error: { code: 'no_credits', message: "You've used your AI credits for now. Upgrade for more — foods from the NutriLog database still log for free." } });
      this.ai.push({ mode: body.mode, body });
      const provider = body.provider === 'claude' && spend.features.claude ? 'claude' : 'gemini';
      const save = (kind, content) => {
        const row = { id: randomUUID(), user_id: u.id, kind, params: {}, content, created_at: new Date().toISOString() };
        this.db.ai_reports.push(row);
        return row;
      };
      if (body.mode === 'weekly_report') {
        const content = { headline: 'A steady week — protein is the thing to fix', wins: ['You logged 2 days.'],
          changes: [{ title: 'Add protein at breakfast', detail: 'Two boiled eggs or 150 g curd.' }], focus: 'Hit 110 g protein on 5 days.',
          stats: { start: '2026-09-27', end: '2026-10-03', days_logged: 2, avg_calories: 1650, target_calories: 1621, calorie_days_on_target: 1, avg_protein: 62.5, target_protein: 110,
            protein_days_hit: 0, avg_carbs: 200, avg_fat: 50, avg_fiber: 20, weight_start: 70, weight_end: 70.5, weight_change: 0.5, active_days: 1, activity_minutes: 30, activity_kcal: 100, avg_water_ml: 580, water_goal_ml: 2000 }, provider };
        const row = save('weekly_report', content);
        return reply(200, { id: row.id, created_at: row.created_at, report: content });
      }
      if (body.mode === 'plan') {
        const it = (food_name, portion, grams, protein, carbs, fat) => ({ food_name, portion, grams, protein, carbs, fat, fiber: 2, calories: Math.round(4 * protein + 4 * carbs + 9 * fat) });
        const meals = [{ meal_type: 'breakfast', items: [it('Vegetable poha', '1 plate', 200, 7, 60, 10)] }, { meal_type: 'lunch', items: [it('Dal tadka', '1 katori', 150, 9, 22.5, 7.5), it('Roti', '2 roti', 80, 7.2, 42.2, 3)] },
          { meal_type: 'snack', items: [it('Roasted chana', '1 handful', 30, 6.6, 17.4, 1.5)] }, { meal_type: 'dinner', items: [it('Paneer bhurji', '1 katori', 150, 22, 9, 25)] }]
          .map((m) => ({ ...m, calories: m.items.reduce((sum, x) => sum + x.calories, 0), protein: m.items.reduce((sum, x) => sum + x.protein, 0) }));
        const days = Array.from({ length: body.days === 7 ? 7 : 1 }, (_, i) => ({ day: i + 1, meals, calories: meals.reduce((sum, m) => sum + m.calories, 0), protein: meals.reduce((sum, m) => sum + m.protein, 0) }));
        const content = { days, grocery: [{ item: 'Poha', quantity: '200 g', category: 'grains' }, { item: 'Paneer', quantity: '150 g', category: 'dairy' }],
          notes: '', targets: { calories: 1621, protein: 110 }, provider };
        const row = save('meal_plan', content);
        return reply(200, { id: row.id, created_at: row.created_at, plan: content });
      }
      return reply(200, { reply: 'You are doing well today. Add some protein at dinner.', foods: [], provider });
    }
    if (name === 'billing') {
      if (!u) return reply(401, { error: { code: 'unauthorized', message: 'Please log in again.' } });
      const [status, out] = this.billing.handle(u.id, body || {});
      return reply(status, out);
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
      for (const sub of this.billing.subs.filter((x) => x.user_id === u.id && ['authenticated', 'active', 'pending'].includes(x.status))) { this.billing.cancels.push(sub.id); sub.status = 'cancelled'; }
      for (const t of Object.keys(this.db)) this.db[t] = this.db[t].filter((r) => r[OWNER[t]] !== u.id);
      this.users.delete(u.id);
      for (const [k, v] of this.tokens) if (v === u.id) this.tokens.delete(k);
      return reply(200, { ok: true });
    }
    return reply(404, { error: { code: 'not_found', message: 'Not found' } });
  }

  /**
   * AI parse stand-in. Like the real function it returns only items whose words are in the text
   * (tests can add an invented item through `parseExtra` to prove it's dropped).
   */
  mockParse(text) {
    const t = ` ${String(text).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ')} `;
    const items = (this.parseScript?.[text] || []).concat(this.parseExtra || []);
    return items.filter((it) => t.includes(` ${it.text_span.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()} `))
      .map((it) => ({ quantity: null, unit: null, amount_vague: false, preparation: null, modifier_of: null, ...it }));
  }

  /** AI estimate stand-in: known test foods get fixed values (energy from macros, like the server). */
  mockEstimate(it, index) {
    const name = String(it.food_name).toLowerCase();
    const known = {
      'jeera rice': { food_name: 'Jeera rice', m: [3, 28, 3, 1], grams: 158, servings: [{ label: '1 katori', grams: 158 }] },
      'homemade peanut chutney': { food_name: 'Peanut chutney', m: [9, 12, 20, 4], grams: 10, servings: [{ label: '1 tbsp', grams: 15 }] },
      'peanut chutney': { food_name: 'Peanut chutney', m: [9, 12, 20, 4], grams: 10, servings: [{ label: '1 tbsp', grams: 15 }] },
    }[name] || { food_name: it.food_name.replace(/^./, (c) => c.toUpperCase()), m: [8, 30, 10, 2], grams: 150, servings: [{ label: '1 serving', grams: 150 }] };
    const [p, c, f, fib] = known.m;
    const grams = it.unit === 'g' && it.quantity ? it.quantity : known.grams;
    return { index, food_name: known.food_name, category: 'dish', grams,
      per_100g: { calories: 4 * p + 4 * c + 9 * f, protein: p, carbs: c, fat: f, fiber: fib, alcohol: 0, sugar: null, saturated_fat: null, sodium_mg: null, cholesterol_mg: null },
      servings: known.servings, confidence: 'high' };
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
