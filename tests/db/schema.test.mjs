// Runs the real Supabase migrations against an in-process Postgres (PGlite) with a minimal
// stand-in for Supabase's auth schema, then verifies Row Level Security and the RPCs.
//   node --test tests/db/
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { nameKey } from '../../js/lib/food-key.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ANON_LEGACY = '33333333-3333-4333-8333-333333333333';
const C = '44444444-4444-4444-8444-444444444444'; // created by the "new auth users" test
const ADMIN = '55555555-5555-4555-8555-555555555555';
let db;

const SUPABASE_STUB = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth; create schema extensions;
  create table auth.users (id uuid primary key, email text, is_anonymous boolean default false, phone text,
    phone_confirmed_at timestamptz, created_at timestamptz default now(), last_sign_in_at timestamptz);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth, extensions, public to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  create publication supabase_realtime;
  -- tables from the previous app version, with data
  create table public.meals (id uuid default gen_random_uuid() primary key, user_id text not null, date date not null,
    food_name text not null, portion text, calories integer, protein numeric, carbs numeric, fat numeric, fiber numeric,
    created_at timestamp default now());
  create table public.user_settings (user_id text primary key, goals text, diet_mode text, body_stats text, updated_at timestamp default now());
  create table public.activities (id uuid default gen_random_uuid() primary key, user_id text not null, date date not null,
    activity_name text not null, duration_min integer default 0, calories_burned integer default 0, created_at timestamp default now());
  create table public.weight_logs (id uuid default gen_random_uuid() primary key, user_id text not null, date date not null,
    weight numeric not null, created_at timestamp default now(), unique(user_id, date));
  insert into public.meals (user_id, date, food_name, portion, calories, protein, carbs, fat, fiber, created_at) values
    ('${ANON_LEGACY}', '2026-09-01', 'Poha', '200g', 360, 7, 60, 10, 3, '2026-09-01 03:00:00'),
    ('${ANON_LEGACY}', '2026-09-01', 'Dal rice', '1 plate', 450, 14, 70, 9, 6, '2026-09-01 08:00:00'),
    ('device-abc', '2026-09-02', 'Old device food', '100g', 100, 1, 1, 1, 1, '2026-09-02 08:00:00');
  insert into public.weight_logs (user_id, date, weight) values ('${ANON_LEGACY}', '2026-09-01', 80.4);
  insert into public.user_settings (user_id, goals, body_stats) values
    ('${ANON_LEGACY}', '{"cal":1900,"prot":130,"carb":200,"fat":60,"fib":30}', '{"weight":80,"height":175,"age":30,"gender":"male","activityLevel":"active"}');
`;

async function as(uid, fn) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid || ''}', false);`);
  await db.exec(uid ? 'set role authenticated' : 'set role anon');
  try { return await fn(); } finally { await db.exec('reset role'); }
}

before(async () => {
  db = new PGlite({ extensions: { pgcrypto, pg_trgm } });
  await db.exec(SUPABASE_STUB);
  await db.exec(`insert into auth.users (id, email) values ('${A}', 'a@example.com'), ('${B}', 'b@example.com'),
                 ('${ANON_LEGACY}', null)`);
  for (const f of ['001_initial_schema.sql', '002_legacy_import.sql', '003_scale_goals_ai.sql', '004_water_ml_favorites.sql',
    '005_global_foods.sql', '006_global_foods_seed.sql', '007_subscriptions.sql']) {
    await db.exec(readFileSync(new URL(`../../supabase/migrations/${f}`, import.meta.url), 'utf8'));
  }
});

test('legacy tables are renamed and hidden from clients', async () => {
  const { rows } = await db.query(`select to_regclass('public.legacy_meals') as m, to_regclass('public.legacy_weight_logs') as w`);
  assert.equal(rows[0].m, 'legacy_meals');
  await as(A, async () => {
    await assert.rejects(db.query('select * from public.legacy_meals'), /permission denied/);
  });
});

test('existing and new auth users get profile, preferences and goals rows', async () => {
  await db.exec(`insert into auth.users (id, email) values ('44444444-4444-4444-8444-444444444444', 'new@example.com')`);
  const { rows } = await db.query(`select (select count(*) from profiles)::int p, (select count(*) from user_preferences)::int u,
                                          (select count(*) from daily_goals)::int g`);
  assert.deepEqual(rows[0], { p: 4, u: 4, g: 4 });
});

test('log_meal_items creates the meal and is idempotent on retry', async () => {
  const items = [
    { id: 'aaaaaaaa-0000-4000-8000-000000000001', food_name: 'Roti', food_id: 'roti', source: 'database', quantity: 2, unit: 'medium roti', grams: 80, calories: 224, protein: 7.2, carbs: 42.16, fat: 2.96, fiber: 6.72 },
    { id: 'aaaaaaaa-0000-4000-8000-000000000002', food_name: 'Dal', quantity: 150, unit: 'g', grams: 150, calories: 156, protein: 9, carbs: 24, fat: 2.7, fiber: 6 },
  ];
  await as(A, async () => {
    const first = await db.query(`select * from log_meal_items('2026-09-29', 'lunch', $1::jsonb)`, [JSON.stringify(items)]);
    assert.equal(first.rows.length, 2);
    const again = await db.query(`select * from log_meal_items('2026-09-29', 'lunch', $1::jsonb)`, [JSON.stringify(items)]);
    assert.equal(again.rows.length, 0, 'retry must not insert duplicates');
    const { rows } = await db.query(`select count(*)::int n, sum(calories)::float c from meal_items where meal_date = '2026-09-29'`);
    assert.deepEqual(rows[0], { n: 2, c: 380 });
    const meals = await db.query(`select count(*)::int n from meals`);
    assert.equal(meals.rows[0].n, 1);
  });
});

test('RLS: users cannot see or modify each other\'s data', async () => {
  await as(B, async () => {
    const { rows } = await db.query('select * from meal_items');
    assert.equal(rows.length, 0);
    const upd = await db.query(`update meal_items set calories = 1 where id = 'aaaaaaaa-0000-4000-8000-000000000001' returning id`);
    assert.equal(upd.rows.length, 0);
    const del = await db.query(`delete from meal_items returning id`);
    assert.equal(del.rows.length, 0);
    const profiles = await db.query('select id from profiles');
    assert.deepEqual(profiles.rows.map((r) => r.id), [B]);
    // Inserting an item into A's meal is rejected.
    const { rows: [meal] } = await db.query(`select id from meals limit 1`).catch(() => ({ rows: [{}] }));
    assert.equal(meal, undefined);
  });
  const { rows: [aMeal] } = await db.query(`select id from meals where user_id = '${A}'`);
  await as(B, async () => {
    await assert.rejects(db.query(`insert into meal_items (meal_id, user_id, food_name, calories) values ($1, '${B}', 'x', 1)`, [aMeal.id]));
    await assert.rejects(db.query(`insert into meal_items (meal_id, user_id, food_name, calories) values ($1, '${A}', 'x', 1)`, [aMeal.id]));
    await assert.rejects(db.query(`insert into weight_history (user_id, recorded_on, weight_kg) values ('${A}', '2026-09-29', 70)`));
  });
});

test('logged_dates returns only the caller\'s distinct days', async () => {
  await as(A, async () => {
    const { rows } = await db.query(`select meal_date::text d from logged_dates()`);
    assert.deepEqual(rows.map((r) => r.d), ['2026-09-29']);
  });
  await as(B, async () => {
    const { rows } = await db.query(`select * from logged_dates()`);
    assert.equal(rows.length, 0);
  });
});

test('RLS: anon role reads nothing', async () => {
  await as(null, async () => {
    await assert.rejects(db.query('select * from meal_items'), /permission denied/);
    await assert.rejects(db.query('select * from profiles'), /permission denied/);
  });
});

test('update_meal_item edits quantity and moves between meals', async () => {
  await as(A, async () => {
    const { rows: [it] } = await db.query(`select * from update_meal_item('aaaaaaaa-0000-4000-8000-000000000002', 'dinner', '{"quantity":300,"grams":300,"calories":312}'::jsonb)`);
    assert.equal(it.meal_type, 'dinner');
    assert.equal(Number(it.calories), 312);
    assert.equal(Number(it.protein), 9, 'fields not in the patch are unchanged');
    const { rows: [renamed] } = await db.query(`select * from update_meal_item('aaaaaaaa-0000-4000-8000-000000000002', null, '{"food_name":"  Dal fry  "}'::jsonb)`);
    assert.equal(renamed.food_name, 'Dal fry');
    const { rows: [blank] } = await db.query(`select * from update_meal_item('aaaaaaaa-0000-4000-8000-000000000002', null, '{"food_name":"  "}'::jsonb)`);
    assert.equal(blank.food_name, 'Dal fry', 'a blank name is ignored');
  });
  await as(B, async () => {
    await assert.rejects(db.query(`select * from update_meal_item('aaaaaaaa-0000-4000-8000-000000000001', null, '{"calories":1}'::jsonb)`), /not found/);
  });
});

test('weight history keeps profiles.weight_kg equal to the latest entry', async () => {
  await as(A, async () => {
    await db.query(`insert into weight_history (recorded_on, weight_kg) values ('2026-09-20', 72.5), ('2026-09-28', 71.8)`);
    let { rows } = await db.query('select weight_kg from profiles');
    assert.equal(Number(rows[0].weight_kg), 71.8);
    await db.query(`delete from weight_history where recorded_on = '2026-09-28'`);
    ({ rows } = await db.query('select weight_kg from profiles'));
    assert.equal(Number(rows[0].weight_kg), 72.5);
  });
});

test('weigh-ins keep 0.01 kg precision, their source and a body-composition snapshot', async () => {
  await as(A, async () => {
    await db.query(`insert into weight_history (recorded_on, weight_kg, source, measured_at, bmi, body_fat_pct, fat_mass_kg,
                      lean_mass_kg, body_water_pct, body_water_l, bmr_kcal, heart_rate_bpm)
                    values ('2026-09-21', 91.55, 'scale', now(), 29.89, 30.12, 27.57, 63.98, 49.6, 45.41, 1872.75, 72)`);
    const { rows: [w] } = await db.query(`select weight_kg, source, heart_rate_bpm, bmr_kcal from weight_history where recorded_on = '2026-09-21'`);
    assert.deepEqual([Number(w.weight_kg), w.source, w.heart_rate_bpm, Number(w.bmr_kcal)], [91.55, 'scale', 72, 1872.75]);
    await assert.rejects(db.query(`insert into weight_history (recorded_on, weight_kg, heart_rate_bpm) values ('2026-09-22', 80, 400)`), /check/);
    await assert.rejects(db.query(`insert into weight_history (recorded_on, weight_kg, source) values ('2026-09-22', 80, 'guess')`), /check/);
    await db.query(`delete from weight_history where recorded_on = '2026-09-21'`);
    // The profile keeps the exact latest weight too.
    await db.query(`update profiles set target_weight_kg = 85.25, target_date = '2026-12-31'`);
    const { rows: [p] } = await db.query('select target_weight_kg, target_date::text d from profiles');
    assert.deepEqual([Number(p.target_weight_kg), p.d], [85.25, '2026-12-31']);
  });
});

test('activities burn net calories from the weight on their date and follow weigh-in changes', async () => {
  const kcal = async (id) => Number((await db.query(`select calories_burned from activities where id = '${id}'`)).rows[0].calories_burned);
  const ACT = 'bbbbbbbb-0000-4000-8000-000000000001';
  const EARLY = 'bbbbbbbb-0000-4000-8000-000000000002';
  const MANUAL = 'bbbbbbbb-0000-4000-8000-000000000003';
  await as(A, async () => {
    // A's weigh-ins at this point: 2026-09-20 → 72.5 kg.
    await db.query(`insert into activities (id, activity_date, name, duration_min, met, calories_burned) values
      ('${ACT}', '2026-09-25', 'Treadmill', 30, 8, 1), ('${EARLY}', '2026-09-10', 'Walk', 30, 8, 1)`);
    assert.equal(await kcal(ACT), 253.75, '(8 − 1) × 72.5 kg × 0.5 h, whatever the client sent');
    assert.equal(await kcal(EARLY), 253.75, 'before the first weigh-in the earliest weight is used');
    await db.query(`insert into weight_history (recorded_on, weight_kg) values ('2026-09-24', 70.25)`);
    assert.equal(await kcal(ACT), 245.88, 'recomputed with the new weight on that date');
    assert.equal(await kcal(EARLY), 253.75, 'earlier activities keep the weight from their own date');
    await db.query(`update weight_history set weight_kg = 92 where recorded_on = '2026-09-24'`);
    assert.equal(await kcal(ACT), 322);
    await db.query(`delete from weight_history where recorded_on = '2026-09-24'`);
    assert.equal(await kcal(ACT), 253.75);
    await db.query(`update activities set duration_min = 45 where id = '${ACT}'`);
    assert.equal(await kcal(ACT), 380.63);
    await db.query(`insert into activities (id, activity_date, name, duration_min, calories_burned) values ('${MANUAL}', '2026-09-25', 'Other', 20, 123.45)`);
    assert.equal(await kcal(MANUAL), 123.45, 'entries without a MET keep the calories given');
  });
  await as(B, async () => {
    assert.equal((await db.query(`select count(*)::int n from activities where id = '${ACT}'`)).rows[0].n, 0);
    assert.equal((await db.query(`select weight_on('${A}', '2026-09-25') w`)).rows[0].w, null, "can't read another user's weight");
  });
});

test('AI model preference defaults to Gemini and only accepts known models', async () => {
  await as(B, async () => {
    assert.equal((await db.query('select ai_provider from user_preferences')).rows[0].ai_provider, 'gemini');
    await db.query(`update user_preferences set ai_provider = 'claude'`);
    assert.equal((await db.query('select ai_provider from user_preferences')).rows[0].ai_provider, 'claude');
    await assert.rejects(db.query(`update user_preferences set ai_provider = 'gpt'`), /check/);
  });
});

test('water is stored in millilitres and stays in sync with glasses both ways', async () => {
  const read = async () => (await db.query(`select ml, glasses from water_logs where log_date = '2026-09-30'`)).rows[0];
  await as(B, async () => {
    await db.query(`insert into water_logs (log_date, ml) values ('2026-09-30', 750)`);
    assert.deepEqual(await read(), { ml: 750, glasses: 3 });
    // An older app version that only knows glasses keeps working.
    await db.query(`insert into water_logs (log_date, glasses) values ('2026-09-30', 5)
                    on conflict (user_id, log_date) do update set glasses = excluded.glasses`);
    assert.deepEqual(await read(), { ml: 1250, glasses: 5 });
    await db.query(`update water_logs set ml = 1100 where log_date = '2026-09-30'`);
    assert.deepEqual(await read(), { ml: 1100, glasses: 4 });
    await assert.rejects(db.query(`update water_logs set ml = 30000 where log_date = '2026-09-30'`), /check/);

    await db.query('update user_preferences set water_goal_ml = 3000');
    let { rows: [p] } = await db.query('select water_goal, water_goal_ml from user_preferences');
    assert.deepEqual([p.water_goal, p.water_goal_ml], [12, 3000]);
    await db.query('update user_preferences set water_goal = 10');
    ({ rows: [p] } = await db.query('select water_goal, water_goal_ml from user_preferences'));
    assert.deepEqual([p.water_goal, p.water_goal_ml], [10, 2500]);
  });
});

test('favorite foods are private to each user', async () => {
  await as(B, async () => {
    await db.query(`insert into favorite_foods (food_name, quantity, unit, grams, calories, protein) values ('Poha', 1, 'plate', 200, 360, 7)`);
    await assert.rejects(db.query(`insert into favorite_foods (food_name, quantity, unit, calories) values ('Poha', 1, 'plate', 300)`), /duplicate|unique/);
    assert.equal((await db.query('select count(*)::int n from favorite_foods')).rows[0].n, 1);
  });
  await as(ANON_LEGACY, async () => {
    assert.equal((await db.query('select count(*)::int n from favorite_foods')).rows[0].n, 0);
    assert.equal((await db.query('update favorite_foods set calories = 1 returning id')).rows.length, 0);
    assert.equal((await db.query('delete from favorite_foods returning id')).rows.length, 0);
    await assert.rejects(db.query(`insert into favorite_foods (user_id, food_name, calories) values ('${B}', 'x', 1)`), /row-level security/);
  });
  await as(null, async () => {
    await assert.rejects(db.query('select * from favorite_foods'), /permission denied/);
  });
});

test('AI quota is enforced per user', async () => {
  await as(A, async () => {
    const results = [];
    for (let i = 0; i < 4; i++) results.push((await db.query(`select consume_ai_quota('food', 3, 100) ok`)).rows[0].ok);
    assert.deepEqual(results, [true, true, true, false]);
  });
  await as(B, async () => {
    assert.equal((await db.query(`select consume_ai_quota('food', 3, 100) ok`)).rows[0].ok, true);
    await assert.rejects(db.query('select * from ai_usage'), /permission denied/);
  });
});

test('recovery codes: hashed, single use, service role only', async () => {
  await as(A, async () => {
    await assert.rejects(db.query(`select set_recovery_code('${A}', 'NUTRI-ABCD-EFGH')`), /permission denied/);
    await assert.rejects(db.query(`select verify_recovery_code('a@example.com', 'NUTRI-ABCD-EFGH')`), /permission denied/);
  });
  await db.query(`select set_recovery_code('${A}', 'nutri-abcd-efgh')`);
  const { rows: [rc] } = await db.query(`select code_hash from recovery_codes where user_id = '${A}'`);
  assert.ok(rc.code_hash.startsWith('$2'), 'stored as bcrypt');
  assert.ok(!rc.code_hash.includes('ABCD'));
  assert.equal((await db.query(`select verify_recovery_code('b@example.com', 'NUTRI-ABCD-EFGH') id`)).rows[0].id, null);
  assert.equal((await db.query(`select verify_recovery_code('A@example.com', 'NUTRI-WRONG-CODE') id`)).rows[0].id, null);
  assert.equal((await db.query(`select verify_recovery_code(' A@example.com ', 'NUTRI-ABCD-EFGH') id`)).rows[0].id, A);
  assert.equal((await db.query(`select verify_recovery_code('a@example.com', 'NUTRI-ABCD-EFGH') id`)).rows[0].id, null, 'single use');
  await as(A, async () => {
    const { rows } = await db.query('select recovery_code_status() s');
    assert.equal(rows[0].s.has_code, false);
  });
});

test('claim_legacy_data moves the caller\'s old rows (anonymous-user upgrade path)', async () => {
  await as(ANON_LEGACY, async () => {
    const { rows: [r] } = await db.query(`select claim_legacy_data('Asia/Kolkata') res`);
    assert.deepEqual(r.res, { meal_items: 2, weights: 1, activities: 0 });
    const items = await db.query('select food_name, meal_type, grams from meal_items order by created_at');
    // 03:00 UTC = 08:30 IST → breakfast; 08:00 UTC = 13:30 IST → lunch
    assert.deepEqual(items.rows.map((i) => [i.food_name, i.meal_type, i.grams == null ? null : Number(i.grams)]),
      [['Poha', 'breakfast', 200], ['Dal rice', 'lunch', null]]);
    const goals = await db.query('select calories, is_custom from daily_goals');
    assert.deepEqual(goals.rows[0], { calories: 1900, is_custom: true });
    const prof = await db.query('select height_cm, age, sex, activity_level from profiles');
    assert.equal(Number(prof.rows[0].height_cm), 175);
    assert.equal(prof.rows[0].activity_level, 'moderate');
    const again = await db.query(`select claim_legacy_data('UTC') res`);
    assert.deepEqual(again.rows[0].res, { meal_items: 0, weights: 0, activities: 0 });
  });
  // Another user's claim never touches someone else's legacy rows.
  const { rows } = await db.query(`select count(*)::int n from legacy_meals where user_id = 'device-abc'`);
  assert.equal(rows[0].n, 1);
});

test('admin import is owner-only', async () => {
  await as(B, async () => {
    await assert.rejects(db.query(`select admin_import_legacy_user('device-abc', '${B}', 'UTC')`), /permission denied/);
  });
  const { rows: [r] } = await db.query(`select admin_import_legacy_user('device-abc', '${B}', 'UTC') res`);
  assert.equal(r.res.meal_items, 1);
});

// ── Global Food Database ────────────────────────────────────────────────────
const AI_CHUTNEY = { name: 'Peanut chutney', protein: 9, carbs: 12, fat: 20, fiber: 4, confidence: 0.9, servings: [{ label: '1 tbsp', grams: 15 }] };
const submit = (food) => db.query('select submit_food($1::jsonb) r', [JSON.stringify(food)]).then((x) => x.rows[0].r);
const resolve = (names) => db.query('select resolve_foods($1::text[]) r', [names]).then((x) => x.rows[0].r);

test('food_key in SQL and nameKey in the app agree', async () => {
  await db.exec(`insert into auth.users (id, email) values ('${ADMIN}', 'admin@example.com'); insert into app_admins (user_id) values ('${ADMIN}')`);
  const names = ['Boiled Eggs', 'egg boiled', 'Roti / Chapati (whole wheat, no ghee)', 'Strawberries', 'Tomatoes', 'Potatoes', 'Hummus',
    'Glass of Milk', 'Dal-Tadka!!', 'chickpeas', 'Café Latte', 'Mango 2', 'cashew nuts', 'Sandwiches', 'peas', 'a bowl of oats'];
  for (const n of names) {
    const { rows: [r] } = await db.query('select food_key($1) k', [n]);
    assert.equal(r.k, nameKey(n), n);
  }
  assert.equal(nameKey('Boiled Eggs'), nameKey('egg boiled'));
});

test('the seeded global foods are shared, sourced and read-only for users', async () => {
  await as(B, async () => {
    const { rows: [n] } = await db.query(`select count(*)::int n from foods where status = 'verified'`);
    assert.ok(n.n >= 100, `${n.n} foods`);
    const { rows: [egg] } = await db.query(`select * from foods where name = 'Boiled egg'`);
    assert.equal(egg.source_id, 'fdc:173424');
    assert.equal(Number(egg.calories), 150.28, '4·12.6 + 4·1.12 + 9·10.6');
    assert.equal(egg.trans_fat, null, 'unknown stays unknown, not zero');
    assert.equal(egg.micros.iron_mg, 1.19);
    const { rows: servings } = await db.query(`select label, grams from food_servings where food_id = $1 order by sort_order`, [egg.id]);
    assert.deepEqual(servings.map((s) => [s.label, Number(s.grams)]), [['1 large egg', 50], ['1 medium egg', 44], ['1 small egg', 38]]);
    await assert.rejects(db.query(`insert into foods (name, name_key, calories, protein, carbs, fat, source_type) values ('X', 'x', 1, 0, 0, 0, 'user_submitted')`), /permission denied/);
    await assert.rejects(db.query(`update foods set calories = 1 where name = 'Boiled egg'`), /permission denied/);
    await assert.rejects(db.query(`delete from food_aliases`), /permission denied/);
    await assert.rejects(db.query(`insert into food_servings (food_id, label, grams) values ('${egg.id}', 'huge', 999)`), /permission denied/);
  });
  await as(null, async () => {
    await assert.rejects(db.query('select * from foods'), /permission denied/);
  });
  const { rows: cols } = await db.query(`select column_name from information_schema.columns where table_name = 'foods'`);
  assert.equal(cols.filter((c) => /user|email|owner|created_by/.test(c.column_name)).length, 0, 'no personal data in the shared table');
});

test('resolve_foods: exact names, aliases (any word order, plurals, Hindi), and fuzzy candidates', async () => {
  await as(B, async () => {
    const r = await resolve(['roti', 'butter', 'boiled eggs', 'anda', 'egg boiled', 'chapatti', 'kela', 'chapatii', 'homemade peanut chutney']);
    assert.deepEqual(r.slice(0, 7).map((x) => [x.match, x.food.name]), [
      ['exact', 'Roti'], ['exact', 'Butter'], ['exact', 'Boiled egg'], ['alias', 'Boiled egg'], ['exact', 'Boiled egg'], ['alias', 'Roti'], ['alias', 'Banana']]);
    assert.equal(r[0].food.servings[0].label, '1 medium roti');
    assert.equal(r[7].match, undefined, 'a typo is not matched automatically…');
    assert.equal(r[7].candidates[0].food.name, 'Roti', '…but offered as a candidate');
    assert.equal(r[8].match, undefined);
    const found = await db.query(`select search_foods('egg', 10) r`);
    const names = found.rows[0].r.map((f) => f.name);
    for (const n of ['Boiled egg', 'Fried egg', 'Scrambled egg', 'Egg white', 'Omelette']) assert.ok(names.includes(n), names.join());
    assert.equal(names.length, new Set(names).size, 'each food once');
  });
});

test('a new AI food is private until a second user confirms matching values, then shared', async () => {
  let id;
  await as(B, async () => {
    const r = await submit(AI_CHUTNEY);
    assert.equal(r.status, 'pending');
    id = r.id;
    assert.equal((await resolve(['peanut chutney']))[0].food.status, 'pending', 'the submitter can use it right away');
  });
  await as(C, async () => {
    assert.equal((await resolve(['peanut chutney']))[0].match, undefined, 'others cannot see an unconfirmed food');
    const r = await submit({ ...AI_CHUTNEY, name: 'chutney, peanut', protein: 9.2 }); // same food, slightly different numbers
    assert.deepEqual([r.id, r.status, r.existing], [id, 'verified', true]);
  });
  await as(ANON_LEGACY, async () => {
    const [hit] = await resolve(['Peanut Chutney']);
    assert.deepEqual([hit.match, hit.food.status, Number(hit.food.calories)], ['exact', 'verified', 264], 'shared with everyone now');
    assert.equal((await db.query('select count(*)::int n from food_submissions')).rows[0].n, 0, 'who submitted it stays private');
  });
});

test('candidate foods are validated: no impossible values, no duplicates, personal recipes stay private', async () => {
  await as(B, async () => {
    await assert.rejects(submit({ ...AI_CHUTNEY, name: 'Mystery bar', protein: 80, carbs: 60, fat: 10 }), /invalid nutrition/);
    await assert.rejects(submit({ ...AI_CHUTNEY, name: 'x' }), /invalid food name/);
    await assert.rejects(submit({ ...AI_CHUTNEY, name: 'Odd food', source_type: 'verified_admin' }), /invalid source/);
    assert.equal((await submit({ ...AI_CHUTNEY, name: "My Mom's Special Curry" })).status, 'private');
    const egg = await submit({ ...AI_CHUTNEY, name: 'Eggs boiled', protein: 1, carbs: 1, fat: 1 });
    assert.deepEqual([egg.status, egg.existing], ['verified', true], 'a known food is never overwritten');
    const { rows: [e] } = await db.query(`select calories from foods where name = 'Boiled egg'`);
    assert.equal(Number(e.calories), 150.28);
    // Two users disagree a lot → needs review, not shared.
    const s1 = await submit({ ...AI_CHUTNEY, name: 'Coconut barfi', protein: 4, carbs: 50, fat: 20 });
    assert.equal(s1.status, 'pending');
  });
  await as(C, async () => {
    const s2 = await submit({ ...AI_CHUTNEY, name: 'coconut barfi', protein: 4, carbs: 30, fat: 10 });
    assert.equal(s2.status, 'needs_review');
    // Product-label data from a barcode is shared at once.
    const bar = await submit({ name: 'Acme Oats', protein: 13, carbs: 68, fat: 6.5, fiber: 10, source_type: 'external_database', source: 'Open Food Facts', source_id: 'off:8901234567890' });
    assert.equal(bar.status, 'verified');
    assert.equal((await db.query(`select food_by_source('off:8901234567890') f`)).rows[0].f.name, 'Acme Oats');
  });
});

test('aliases become shared after two different users use them', async () => {
  const { rows: [egg] } = await db.query(`select id from foods where name = 'Boiled egg'`);
  await as(B, async () => { assert.equal((await db.query(`select propose_food_alias('ubla hua anda', $1) r`, [egg.id])).rows[0].r, 'proposed'); });
  await as(C, async () => {
    assert.equal((await resolve(['ubla hua anda']))[0].match, undefined);
    assert.equal((await db.query(`select propose_food_alias('Ubla Hua Anda', $1) r`, [egg.id])).rows[0].r, 'added');
    assert.equal((await resolve(['ubla hua anda']))[0].food.name, 'Boiled egg');
  });
});

test('logged items keep a nutrition snapshot that later edits to the shared food never change', async () => {
  const { rows: [egg] } = await db.query(`select id, version from foods where name = 'Boiled egg'`);
  let pending;
  await as(B, async () => {
    pending = await submit({ ...AI_CHUTNEY, name: 'Coconut barfi slice', protein: 3, carbs: 55, fat: 18 }); // only B knows it
    const items = [
      { id: '66666666-6666-4666-8666-666666666661', food_name: 'Boiled egg', source: 'global', quantity: 4, unit: 'egg', grams: 200, calories: 300.56, protein: 25.2, carbs: 2.24, fat: 21.2, fiber: 0, food_ref: egg.id, micros: { iron_mg: 2.38 } },
      { id: '66666666-6666-4666-8666-666666666662', food_name: 'Coconut barfi slice', source: 'ai_text', quantity: 1, unit: 'g', grams: 40, calories: 150, protein: 1, carbs: 20, fat: 8, fiber: 0, food_ref: pending.id },
      { id: '66666666-6666-4666-8666-666666666663', food_name: 'Bad ref', source: 'manual', quantity: 1, unit: 'g', calories: 1, food_ref: 'not-a-uuid' },
    ];
    const { rows } = await db.query(`select * from log_meal_items('2026-10-03', 'breakfast', $1::jsonb)`, [JSON.stringify(items)]);
    assert.deepEqual(rows.map((r) => [r.food_ref, r.food_version, r.micros?.iron_mg ?? null]), [[egg.id, egg.version, 2.38], [pending.id, 1, null], [null, null, null]]);
  });
  await as(C, async () => {
    // C can't see B's pending barfi, so the reference is dropped rather than leaking it.
    const { rows } = await db.query(`select * from log_meal_items('2026-10-03', 'lunch', $1::jsonb)`,
      [JSON.stringify([{ food_name: 'Barfi', source: 'ai_text', calories: 100, food_ref: pending.id }])]);
    assert.equal(rows[0].food_ref, null);
  });
  await as(ADMIN, async () => {
    const f = (await db.query(`select admin_update_food($1, '{"protein": 13}'::jsonb) f`, [egg.id])).rows[0].f;
    assert.equal(f.version, egg.version + 1);
  });
  const { rows: [item] } = await db.query(`select calories, food_version from meal_items where id = '66666666-6666-4666-8666-666666666661'`);
  assert.deepEqual([Number(item.calories), item.food_version], [300.56, egg.version], 'history unchanged');
});

test('admin tools: only admins, and merging keeps every logged meal intact', async () => {
  await as(B, async () => {
    await assert.rejects(db.query(`select admin_overview()`), /admins only/);
    await assert.rejects(db.query(`select admin_set_food_status(gen_random_uuid(), 'verified')`), /admins only/);
    const { rows: [egg] } = await db.query(`select id from foods where name = 'Boiled egg'`);
    await db.query(`insert into food_corrections (food_id, suggested, reason) values ($1, '{"protein": 12.6}', 'USDA says 12.6')`, [egg.id]);
    await assert.rejects(db.query(`insert into food_corrections (food_id, user_id, suggested) values ($1, '${C}', '{}')`, [egg.id]), /row-level security/);
  });
  await as(C, async () => { assert.equal((await db.query('select count(*)::int n from food_corrections')).rows[0].n, 0, "others' reports are private"); });
  await as(ADMIN, async () => {
    const o = (await db.query(`select admin_overview() o`)).rows[0].o;
    assert.ok(o.queue.some((f) => f.name === 'Coconut barfi' && f.status === 'needs_review'));
    assert.equal(o.corrections.length, 1);
    await db.query(`select admin_review_correction($1, true)`, [o.corrections[0].id]);
    const { rows: [egg] } = await db.query(`select protein, status from foods where name = 'Boiled egg'`);
    assert.deepEqual([Number(egg.protein), egg.status], [12.6, 'verified']);
    const barfi = o.queue.find((f) => f.name === 'Coconut barfi slice');
    const { rows: [chutney] } = await db.query(`select id from foods where name = 'Peanut chutney'`);
    await db.query(`select admin_merge_foods($1, $2)`, [barfi.id, chutney.id]);
  });
  const { rows } = await db.query(`select food_ref, calories from meal_items where id = '66666666-6666-4666-8666-666666666662'`);
  assert.equal(Number(rows[0].calories), 150, 'merged: meal kept its own nutrition');
  await as(B, async () => {
    const [hit] = await resolve(['coconut barfi slice']);
    assert.deepEqual([hit.match, hit.food.name], ['alias', 'Peanut chutney'], 'the duplicate name now points to the kept food');
  });
});

test('food resolution statistics are counted per day and visible to admins only', async () => {
  await as(B, async () => {
    await db.query('select record_food_resolution(3, 0, 1, 1)');
    await db.query('select record_food_resolution(2, 1, 0, 0)');
    await assert.rejects(db.query('select * from food_resolution_stats'), /permission denied/);
  });
  await as(ADMIN, async () => {
    const [today] = (await db.query(`select admin_overview() o`)).rows[0].o.stats;
    assert.deepEqual([today.items, today.global_hits, today.external_hits, today.ai_items, today.ai_calls, today.ai_calls_avoided], [7, 5, 1, 1, 1, 6]);
  });
});

// ── Subscriptions, credits, trial ──────────────────────────────────────────
const D = '77777777-7777-4777-8777-777777777777';
const E = '88888888-8888-4888-8888-888888888888';
async function asService(fn) {
  await db.exec('reset role; set role service_role');
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const ent = (uid) => asService(() => db.query('select entitlement_for($1) e', [uid]).then((r) => r.rows[0].e));
const spend = (uid, action) => asService(() => db.query('select consume_credits($1, $2) r', [uid, action]).then((r) => r.rows[0].r));
const addSub = (row) => db.query(`insert into billing_subscriptions (id, user_id, plan_id, period, is_trial, status, start_at, current_start, current_end, cancel_at_cycle_end, mode)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'test')`, [row.id, row.user, row.plan, row.period || 'month', !!row.trial, row.status,
  row.start_at || null, row.current_start || null, row.current_end || null, !!row.cancel]);
const days = (n) => new Date(Date.now() + n * 86400000).toISOString();

test('plans and prices are readable, not writable; Free starts with 20 credits', async () => {
  await db.exec(`insert into auth.users (id, email) values ('${D}', 'd@example.com'), ('${E}', 'e@example.com')`);
  await as(D, async () => {
    const { rows } = await db.query('select plan_id, period, list_paise, price_paise, gst_rate from plan_prices order by plan_id, period');
    assert.deepEqual(rows.map((r) => [r.plan_id, r.period, r.list_paise, r.price_paise, Number(r.gst_rate)]),
      [['pro', 'month', 29900, 14900, 0.18], ['pro', 'year', 358800, 99900, 0.18], ['pro_ai', 'month', 60000, 29900, 0.18], ['pro_ai', 'year', 720000, 199900, 0.18]]);
    await assert.rejects(db.query(`update plan_prices set price_paise = 100`), /permission denied/);
    await assert.rejects(db.query(`insert into billing_subscriptions (id, user_id, plan_id, period, status, mode) values ('sub_x', '${D}', 'pro_ai', 'month', 'active', 'test')`), /permission denied/);
    const e = (await db.query('select my_entitlement() e')).rows[0].e;
    assert.deepEqual([e.plan, e.source, e.credits.allowance, e.credits.remaining], ['free', 'free', 20, 20]);
    await assert.rejects(db.query(`select consume_credits('${D}', 'chat')`), /permission denied/, 'users cannot spend or refund credits directly');
    await assert.rejects(db.query(`select refund_credits('${D}', 'm:2026-10', 5)`), /permission denied/);
    await assert.rejects(db.query(`select entitlement_for('${E}')`), /permission denied/, "nobody can read another user's plan");
  });
});

test('AI credits: spent per action, never past the allowance, refundable by the server', async () => {
  for (let i = 0; i < 4; i++) assert.equal((await spend(D, 'food_image')).ok, true); // 4 × 5 = 20
  const no = await spend(D, 'chat');
  assert.deepEqual([no.ok, no.remaining, no.plan], [false, 0, 'free']);
  const before = await ent(D);
  await asService(() => db.query('select refund_credits($1, $2, 5)', [D, before.credits.period_key]));
  assert.equal((await ent(D)).credits.remaining, 5);
  await assert.rejects(spend(D, 'unknown_action'), /unknown action/);
});

test('subscriptions: active, trial (also when cancelled during it), past-due grace, halted, cancelled until period end', async () => {
  await addSub({ id: 'sub_trial', user: E, plan: 'pro_ai', trial: true, status: 'authenticated', start_at: days(7) });
  let e = await ent(E);
  assert.deepEqual([e.plan, e.source, e.status, e.credits.allowance, e.credits.period_key], ['pro_ai', 'trial', 'trialing', 150, 't:sub_trial']);
  assert.equal(e.features.claude, true);
  await db.query(`update billing_subscriptions set status = 'cancelled' where id = 'sub_trial'`);
  e = await ent(E);
  assert.deepEqual([e.plan, e.status, e.cancel_at_period_end], ['pro_ai', 'trialing', true], 'cancelled trial keeps access until it ends');
  await db.query(`update billing_subscriptions set start_at = $1 where id = 'sub_trial'`, [days(-1)]);
  assert.equal((await ent(E)).plan, 'free', 'trial over, nothing charged');

  await addSub({ id: 'sub_pro', user: E, plan: 'pro', status: 'active', current_start: days(-3), current_end: days(27) });
  e = await ent(E);
  assert.deepEqual([e.plan, e.source, e.status, e.credits.allowance], ['pro', 'subscription', 'active', 150]);
  await db.query(`update billing_subscriptions set status = 'pending', current_end = $1 where id = 'sub_pro'`, [days(-1)]);
  assert.deepEqual([(await ent(E)).plan, (await ent(E)).status], ['pro', 'past_due'], 'payment retrying: 3-day grace');
  await db.query(`update billing_subscriptions set status = 'halted' where id = 'sub_pro'`);
  assert.equal((await ent(E)).plan, 'free');
  await db.query(`update billing_subscriptions set status = 'cancelled', current_end = $1 where id = 'sub_pro'`, [days(10)]);
  assert.deepEqual([(await ent(E)).plan, (await ent(E)).status], ['pro', 'cancelling']);
  await as(E, async () => {
    assert.equal((await db.query('select count(*)::int n from billing_subscriptions')).rows[0].n, 2);
  });
  await as(D, async () => {
    assert.equal((await db.query('select count(*)::int n from billing_subscriptions')).rows[0].n, 0, "others' billing is private");
  });
});

test('phone numbers: verified only by Supabase Auth, never by the user', async () => {
  await as(D, async () => {
    await db.query(`update profiles set phone = '+919876543210', phone_verified = true`);
    const { rows: [p] } = await db.query('select phone, phone_verified from profiles');
    assert.deepEqual([p.phone, p.phone_verified], ['+919876543210', false]);
    await assert.rejects(db.query(`update profiles set phone = '98765'`), /check/);
  });
  await db.query(`update auth.users set phone = '919876543210', phone_confirmed_at = now() where id = '${D}'`);
  const { rows: [p] } = await db.query(`select phone, phone_verified from profiles where id = '${D}'`);
  assert.deepEqual([p.phone, p.phone_verified], ['+919876543210', true]);
});

test('the free trial: once per phone and per email — even after the account is deleted', async () => {
  const elig = (uid, verified = true) => asService(() => db.query('select trial_eligibility_for($1, $2) r', [uid, verified]).then((r) => r.rows[0].r));
  await db.query(`update profiles set phone = '+919800000000' where id = '${E}'`);
  assert.equal((await elig(E, false)).reason, 'already_subscribed');
  const F = '99999999-9999-4999-8999-999999999999';
  const G = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await db.exec(`insert into auth.users (id, email) values ('${F}', 'f@example.com'), ('${G}', 'g@example.com')`);
  assert.equal((await elig(F)).reason, 'no_phone');
  await db.query(`update profiles set phone = '+919811111111' where id = '${F}'`);
  assert.equal((await elig(F)).reason, 'phone_unverified');
  assert.deepEqual(await elig(F, false), { eligible: true, reason: null }, 'allowed while WhatsApp verification is off');
  assert.equal(await asService(() => db.query(`select claim_trial('${F}', 'sub_f') r`).then((r) => r.rows[0].r)), true);
  assert.equal(await asService(() => db.query(`select claim_trial('${F}', 'sub_f2') r`).then((r) => r.rows[0].r)), false);
  await db.query(`update profiles set phone = '+919811111111' where id = '${G}'`);
  assert.equal((await elig(G, false)).reason, 'phone_used', 'same number on another account');
  // Delete F, sign up again with the same email and a new number: still no second trial.
  await db.query(`delete from auth.users where id = '${F}'`);
  await db.query(`update auth.users set email = 'F@Example.com' where id = '${G}'`);
  await db.query(`update profiles set phone = '+919822222222' where id = '${G}'`);
  assert.equal((await elig(G, false)).reason, 'email_used');
  assert.equal((await db.query('select count(*)::int n from trial_claims')).rows[0].n, 1, 'the claim outlived the account');
  const { rows: [c] } = await db.query('select * from trial_claims');
  assert.equal(c.user_id, null);
  assert.doesNotMatch(JSON.stringify(c), /98111|example/i, 'only hashes are stored');
  await as(G, async () => { await assert.rejects(db.query('select * from trial_claims'), /permission denied/); });
});

test('admin: grant a plan, add credits, see users and billing — admins only', async () => {
  await as(D, async () => {
    await assert.rejects(db.query(`select admin_grant_plan('${D}', 'pro_ai', 30, 'self')`), /admins only/);
    await assert.rejects(db.query(`select admin_users('')`), /admins only/);
  });
  await as(ADMIN, async () => {
    await db.query(`select admin_grant_plan('${D}', 'pro_ai', 30, 'tester')`);
    await db.query(`select admin_add_credits('${D}', 50)`);
    const users = (await db.query(`select admin_users('d@ex') u`)).rows[0].u;
    assert.deepEqual([users.length, users[0].phone, users[0].entitlement.plan, users[0].entitlement.source], [1, '+919876543210', 'pro_ai', 'grant']);
    assert.equal(users[0].entitlement.credits.allowance, 650);
    const o = (await db.query('select admin_billing_overview() o')).rows[0].o;
    assert.ok(o.users.pro_ai >= 1);
  });
  await as(D, async () => {
    assert.equal((await db.query('select my_entitlement() e')).rows[0].e.plan, 'pro_ai');
    await db.query(`insert into ai_reports (kind, content) values ('weekly_report', '{"headline": "ok"}')`);
  });
  await as(E, async () => { assert.equal((await db.query('select count(*)::int n from ai_reports')).rows[0].n, 0); });
});

test('deleting an auth user cascades to all of their data', async () => {
  await db.query(`delete from auth.users where id = '${A}'`);
  const { rows } = await db.query(`select
    (select count(*) from profiles where id = '${A}')::int +
    (select count(*) from meal_items where user_id = '${A}')::int +
    (select count(*) from meals where user_id = '${A}')::int +
    (select count(*) from weight_history where user_id = '${A}')::int +
    (select count(*) from activities where user_id = '${A}')::int +
    (select count(*) from ai_usage where user_id = '${A}')::int as n`);
  assert.equal(rows[0].n, 0);
});
