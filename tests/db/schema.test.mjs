// Runs the real Supabase migrations against an in-process Postgres (PGlite) with a minimal
// stand-in for Supabase's auth schema, then verifies Row Level Security and the RPCs.
//   node --test tests/db/
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ANON_LEGACY = '33333333-3333-4333-8333-333333333333';
let db;

const SUPABASE_STUB = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth; create schema extensions;
  create table auth.users (id uuid primary key, email text, is_anonymous boolean default false);
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
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(SUPABASE_STUB);
  await db.exec(`insert into auth.users (id, email) values ('${A}', 'a@example.com'), ('${B}', 'b@example.com'),
                 ('${ANON_LEGACY}', null)`);
  for (const f of ['001_initial_schema.sql', '002_legacy_import.sql']) {
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

test('deleting an auth user cascades to all of their data', async () => {
  await db.query(`delete from auth.users where id = '${A}'`);
  const { rows } = await db.query(`select
    (select count(*) from profiles where id = '${A}')::int +
    (select count(*) from meal_items where user_id = '${A}')::int +
    (select count(*) from meals where user_id = '${A}')::int +
    (select count(*) from weight_history where user_id = '${A}')::int +
    (select count(*) from ai_usage where user_id = '${A}')::int as n`);
  assert.equal(rows[0].n, 0);
});
