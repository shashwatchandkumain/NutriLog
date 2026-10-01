-- NutriLog — initial schema
--
-- Every user-owned row is linked to auth.users(id) and protected by Row Level Security:
-- an authenticated user can only read and write rows where user_id = auth.uid().
-- Nothing here is readable by the anon role.
--
-- Safe to run on a project that used the previous NutriLog version: the old tables
-- (meals / user_settings / activities / weight_logs, keyed by a text user_id) are renamed
-- to legacy_* and left untouched. See 002_legacy_import.sql for moving that data over.

-- ───────────────────────────────────────────────────────────────────────────
-- 0. Preserve tables from the previous app version
-- ───────────────────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'meals' and column_name = 'food_name') then
    alter table public.meals rename to legacy_meals;
  end if;
  if to_regclass('public.user_settings') is not null then
    alter table public.user_settings rename to legacy_user_settings;
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'activities' and column_name = 'user_id' and data_type = 'text') then
    alter table public.activities rename to legacy_activities;
  end if;
  if to_regclass('public.weight_logs') is not null then
    alter table public.weight_logs rename to legacy_weight_logs;
  end if;
end $$;

-- Legacy tables are only reachable through the SECURITY DEFINER import functions.
do $$
declare t text;
begin
  foreach t in array array['legacy_meals', 'legacy_user_settings', 'legacy_activities', 'legacy_weight_logs'] loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);
      execute format('revoke all on table public.%I from anon, authenticated', t);
    end if;
  end loop;
end $$;

create extension if not exists pgcrypto with schema extensions;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Helpers
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Tables
-- ───────────────────────────────────────────────────────────────────────────
create table public.profiles (
  id                   uuid primary key references auth.users (id) on delete cascade,
  display_name         text check (char_length(display_name) <= 80),
  age                  smallint check (age between 13 and 120),
  sex                  text check (sex in ('male', 'female')),
  height_cm            numeric(5, 1) check (height_cm between 90 and 250),
  weight_kg            numeric(5, 1) check (weight_kg between 25 and 400),
  start_weight_kg      numeric(5, 1) check (start_weight_kg between 25 and 400),
  target_weight_kg     numeric(5, 1) check (target_weight_kg between 25 and 400),
  goal                 text not null default 'maintain' check (goal in ('lose', 'maintain', 'gain', 'muscle')),
  activity_level       text not null default 'sedentary'
                         check (activity_level in ('sedentary', 'light', 'moderate', 'active', 'very_active')),
  daily_steps          integer check (daily_steps between 0 and 100000),
  workouts_per_week    smallint check (workouts_per_week between 0 and 14),
  diet_type            text check (diet_type in ('vegetarian', 'eggetarian', 'non_vegetarian', 'vegan')),
  macro_style          text not null default 'balanced' check (macro_style in ('balanced', 'high_protein', 'low_carb', 'keto')),
  allergies            text[] not null default '{}' check (cardinality(allergies) <= 20),
  onboarding_completed boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create table public.user_preferences (
  user_id           uuid primary key references auth.users (id) on delete cascade,
  weight_unit       text not null default 'kg' check (weight_unit in ('kg', 'lb')),
  height_unit       text not null default 'cm' check (height_unit in ('cm', 'ftin')),
  theme             text not null default 'system' check (theme in ('system', 'light', 'dark')),
  water_goal        smallint not null default 8 check (water_goal between 1 and 30),
  exercise_mode     text not null default 'included' check (exercise_mode in ('included', 'add')),
  reminders_enabled boolean not null default false,
  reminder_time     time not null default '20:00',
  updated_at        timestamptz not null default now()
);

-- Targets are recomputed from the profile only while is_custom = false.
create table public.daily_goals (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  calories   integer check (calories between 800 and 10000),
  protein_g  numeric(6, 1) check (protein_g between 0 and 600),
  carbs_g    numeric(6, 1) check (carbs_g between 0 and 1500),
  fat_g      numeric(6, 1) check (fat_g between 0 and 600),
  fiber_g    numeric(6, 1) check (fiber_g between 0 and 150),
  is_custom  boolean not null default false,
  updated_at timestamptz not null default now()
);

create table public.meals (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  meal_date  date not null,
  meal_type  text not null check (meal_type in ('breakfast', 'lunch', 'dinner', 'snack')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, meal_date, meal_type)
);

-- Nutrition is stored for the logged quantity, unrounded (rounding happens only for display).
-- meal_date / meal_type are copied from the parent meal by a trigger for fast range queries.
create table public.meal_items (
  id         uuid primary key default gen_random_uuid(),
  meal_id    uuid not null references public.meals (id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  meal_date  date not null,
  meal_type  text not null,
  food_id    text check (char_length(food_id) <= 100),
  food_name  text not null check (char_length(food_name) between 1 and 200),
  source     text not null default 'manual'
               check (source in ('database', 'ai_text', 'ai_photo', 'barcode', 'manual', 'chat', 'legacy')),
  quantity   numeric(10, 2) not null default 1 check (quantity > 0 and quantity <= 10000),
  unit       text not null default 'g' check (char_length(unit) between 1 and 60),
  grams      numeric(10, 2) check (grams >= 0 and grams <= 20000),
  calories   numeric(10, 2) not null check (calories between 0 and 20000),
  protein    numeric(10, 2) not null default 0 check (protein between 0 and 2000),
  carbs      numeric(10, 2) not null default 0 check (carbs between 0 and 2000),
  fat        numeric(10, 2) not null default 0 check (fat between 0 and 2000),
  fiber      numeric(10, 2) not null default 0 check (fiber between 0 and 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.weight_history (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  recorded_on date not null,
  weight_kg   numeric(5, 1) not null check (weight_kg between 20 and 400),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, recorded_on)
);

create table public.activities (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users (id) on delete cascade,
  activity_date   date not null,
  name            text not null check (char_length(name) between 1 and 120),
  duration_min    integer not null default 0 check (duration_min between 0 and 1440),
  calories_burned numeric(8, 1) not null default 0 check (calories_burned between 0 and 10000),
  source          text not null default 'manual' check (source in ('preset', 'ai', 'manual', 'legacy')),
  created_at      timestamptz not null default now()
);

create table public.water_logs (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  log_date   date not null,
  glasses    smallint not null default 0 check (glasses between 0 and 40),
  updated_at timestamptz not null default now(),
  primary key (user_id, log_date)
);

-- Server-only tables (no client policies): recovery codes, recovery attempts, AI usage.
create table public.recovery_codes (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  code_hash  text not null,            -- bcrypt hash; the plain code is shown to the user once
  created_at timestamptz not null default now(),
  used_at    timestamptz
);

create table public.recovery_attempts (
  id           bigint generated always as identity primary key,
  email_hash   text not null,
  success      boolean not null default false,
  attempted_at timestamptz not null default now()
);

create table public.ai_usage (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  kind       text not null,
  created_at timestamptz not null default now()
);

create index meal_items_user_date_idx on public.meal_items (user_id, meal_date);
create index meal_items_meal_idx on public.meal_items (meal_id);
create index weight_history_user_date_idx on public.weight_history (user_id, recorded_on);
create index activities_user_date_idx on public.activities (user_id, activity_date);
create index ai_usage_user_time_idx on public.ai_usage (user_id, created_at);
create index recovery_attempts_email_time_idx on public.recovery_attempts (email_hash, attempted_at);

create trigger profiles_updated_at before update on public.profiles for each row execute function public.set_updated_at();
create trigger user_preferences_updated_at before update on public.user_preferences for each row execute function public.set_updated_at();
create trigger daily_goals_updated_at before update on public.daily_goals for each row execute function public.set_updated_at();
create trigger meals_updated_at before update on public.meals for each row execute function public.set_updated_at();
create trigger meal_items_updated_at before update on public.meal_items for each row execute function public.set_updated_at();
create trigger weight_history_updated_at before update on public.weight_history for each row execute function public.set_updated_at();
create trigger water_logs_updated_at before update on public.water_logs for each row execute function public.set_updated_at();

-- meal_items: copy date/type from the parent meal and require the same owner.
create or replace function public.meal_items_sync_meal()
returns trigger language plpgsql set search_path = '' as $$
declare m record;
begin
  select user_id, meal_date, meal_type into m from public.meals where id = new.meal_id;
  if not found or m.user_id <> new.user_id then
    raise exception 'meal not found' using errcode = '23503';
  end if;
  new.meal_date := m.meal_date;
  new.meal_type := m.meal_type;
  return new;
end $$;

create trigger meal_items_sync_meal before insert or update of meal_id, user_id on public.meal_items
  for each row execute function public.meal_items_sync_meal();

-- Keep profiles.weight_kg equal to the most recent weigh-in (works across devices).
create or replace function public.weight_history_sync_profile()
returns trigger language plpgsql set search_path = '' as $$
declare uid uuid := coalesce(new.user_id, old.user_id);
declare latest numeric;
begin
  select weight_kg into latest from public.weight_history
    where user_id = uid order by recorded_on desc limit 1;
  if latest is not null then
    update public.profiles set weight_kg = latest where id = uid and weight_kg is distinct from latest;
  end if;
  return null;
end $$;

create trigger weight_history_sync_profile after insert or update or delete on public.weight_history
  for each row execute function public.weight_history_sync_profile();

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Row Level Security
-- ───────────────────────────────────────────────────────────────────────────
alter table public.profiles          enable row level security;
alter table public.user_preferences  enable row level security;
alter table public.daily_goals       enable row level security;
alter table public.meals             enable row level security;
alter table public.meal_items        enable row level security;
alter table public.weight_history    enable row level security;
alter table public.activities        enable row level security;
alter table public.water_logs        enable row level security;
alter table public.recovery_codes    enable row level security;
alter table public.recovery_attempts enable row level security;
alter table public.ai_usage          enable row level security;

-- The anon role never touches user data.
revoke all on public.profiles, public.user_preferences, public.daily_goals, public.meals, public.meal_items,
  public.weight_history, public.activities, public.water_logs, public.recovery_codes,
  public.recovery_attempts, public.ai_usage from anon;
-- Server-only tables: no access for signed-in users either (Edge Functions use the service role).
revoke all on public.recovery_codes, public.recovery_attempts, public.ai_usage from authenticated;

create policy profiles_select on public.profiles for select to authenticated using ((select auth.uid()) = id);
create policy profiles_insert on public.profiles for insert to authenticated with check ((select auth.uid()) = id);
create policy profiles_update on public.profiles for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

create policy prefs_select on public.user_preferences for select to authenticated using ((select auth.uid()) = user_id);
create policy prefs_insert on public.user_preferences for insert to authenticated with check ((select auth.uid()) = user_id);
create policy prefs_update on public.user_preferences for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy goals_select on public.daily_goals for select to authenticated using ((select auth.uid()) = user_id);
create policy goals_insert on public.daily_goals for insert to authenticated with check ((select auth.uid()) = user_id);
create policy goals_update on public.daily_goals for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy meals_all on public.meals for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy meal_items_select on public.meal_items for select to authenticated using ((select auth.uid()) = user_id);
create policy meal_items_insert on public.meal_items for insert to authenticated
  with check ((select auth.uid()) = user_id
              and exists (select 1 from public.meals m where m.id = meal_id and m.user_id = (select auth.uid())));
create policy meal_items_update on public.meal_items for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id
              and exists (select 1 from public.meals m where m.id = meal_id and m.user_id = (select auth.uid())));
create policy meal_items_delete on public.meal_items for delete to authenticated using ((select auth.uid()) = user_id);

create policy weight_all on public.weight_history for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy activities_all on public.activities for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy water_all on public.water_logs for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- ───────────────────────────────────────────────────────────────────────────
-- 4. New-user bootstrap
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  insert into public.user_preferences (user_id) values (new.id) on conflict do nothing;
  insert into public.daily_goals (user_id) values (new.id) on conflict do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Users that existed before this migration.
insert into public.profiles (id) select id from auth.users on conflict do nothing;
insert into public.user_preferences (user_id) select id from auth.users on conflict do nothing;
insert into public.daily_goals (user_id) select id from auth.users on conflict do nothing;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. RPCs used by the app (SECURITY INVOKER — RLS still applies)
-- ───────────────────────────────────────────────────────────────────────────

-- Logs one or more items to a meal in a single transaction. Item ids are generated by the
-- client, so retrying the same call (e.g. after a network failure) never creates duplicates.
create or replace function public.log_meal_items(p_meal_date date, p_meal_type text, p_items jsonb)
returns setof public.meal_items
language plpgsql security invoker set search_path = '' as $$
declare v_meal_id uuid;
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 50 then
    raise exception 'p_items must be an array of 1-50 items' using errcode = '22023';
  end if;

  insert into public.meals (user_id, meal_date, meal_type)
    values (uid, p_meal_date, p_meal_type)
    on conflict (user_id, meal_date, meal_type) do update set updated_at = now()
    returning id into v_meal_id;

  return query
  insert into public.meal_items (id, meal_id, user_id, meal_date, meal_type, food_id, food_name, source,
                                 quantity, unit, grams, calories, protein, carbs, fat, fiber)
  select coalesce((x ->> 'id')::uuid, gen_random_uuid()), v_meal_id, uid, p_meal_date, p_meal_type,
         nullif(x ->> 'food_id', ''), left(x ->> 'food_name', 200), coalesce(x ->> 'source', 'manual'),
         coalesce((x ->> 'quantity')::numeric, 1), left(coalesce(nullif(x ->> 'unit', ''), 'g'), 60),
         (x ->> 'grams')::numeric,
         round(coalesce((x ->> 'calories')::numeric, 0), 2), round(coalesce((x ->> 'protein')::numeric, 0), 2),
         round(coalesce((x ->> 'carbs')::numeric, 0), 2),    round(coalesce((x ->> 'fat')::numeric, 0), 2),
         round(coalesce((x ->> 'fiber')::numeric, 0), 2)
  from jsonb_array_elements(p_items) as x
  on conflict (id) do nothing
  returning *;
end $$;

-- Edits an item's quantity/nutrition and optionally moves it to another meal of the same day.
create or replace function public.update_meal_item(p_id uuid, p_meal_type text, p_patch jsonb)
returns public.meal_items
language plpgsql security invoker set search_path = '' as $$
declare uid uuid := auth.uid();
declare item public.meal_items;
declare v_meal_id uuid;
begin
  if uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  select * into item from public.meal_items where id = p_id and user_id = uid;
  if not found then raise exception 'item not found' using errcode = 'P0002'; end if;

  v_meal_id := item.meal_id;
  if p_meal_type is not null and p_meal_type <> item.meal_type then
    insert into public.meals (user_id, meal_date, meal_type) values (uid, item.meal_date, p_meal_type)
      on conflict (user_id, meal_date, meal_type) do update set updated_at = now()
      returning id into v_meal_id;
  end if;

  update public.meal_items set
    meal_id  = v_meal_id,
    quantity = coalesce((p_patch ->> 'quantity')::numeric, quantity),
    unit     = coalesce(left(nullif(p_patch ->> 'unit', ''), 60), unit),
    grams    = coalesce((p_patch ->> 'grams')::numeric, grams),
    calories = coalesce(round((p_patch ->> 'calories')::numeric, 2), calories),
    protein  = coalesce(round((p_patch ->> 'protein')::numeric, 2), protein),
    carbs    = coalesce(round((p_patch ->> 'carbs')::numeric, 2), carbs),
    fat      = coalesce(round((p_patch ->> 'fat')::numeric, 2), fat),
    fiber    = coalesce(round((p_patch ->> 'fiber')::numeric, 2), fiber)
  where id = p_id and user_id = uid
  returning * into item;
  return item;
end $$;

-- Distinct days with at least one logged item (for streaks and the calendar).
create or replace function public.logged_dates(p_since date default null)
returns table (meal_date date)
language sql stable security invoker set search_path = '' as $$
  select distinct i.meal_date from public.meal_items i
  where i.user_id = auth.uid() and (p_since is null or i.meal_date >= p_since)
  order by 1;
$$;

-- Whether the signed-in user has an unused recovery code (never returns the hash).
create or replace function public.recovery_code_status()
returns jsonb language sql security definer set search_path = '' stable as $$
  select jsonb_build_object(
    'has_code', exists (select 1 from public.recovery_codes where user_id = auth.uid() and used_at is null),
    'created_at', (select created_at from public.recovery_codes where user_id = auth.uid() and used_at is null));
$$;

-- AI quota: atomically checks the caller's recent usage and records one request.
-- Called by the AI Edge Functions with the user's JWT. Returns false when over the limit.
create or replace function public.consume_ai_quota(p_kind text, p_hourly int, p_daily int)
returns boolean language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid();
declare n_hour int;
declare n_day int;
begin
  if uid is null then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text, 42));
  select count(*) filter (where created_at > now() - interval '1 hour'),
         count(*) filter (where created_at > now() - interval '1 day')
    into n_hour, n_day
    from public.ai_usage where user_id = uid and created_at > now() - interval '1 day';
  if n_hour >= greatest(p_hourly, 1) or n_day >= greatest(p_daily, 1) then return false; end if;
  insert into public.ai_usage (user_id, kind) values (uid, left(p_kind, 40));
  return true;
end $$;

-- Recovery-code helpers — service role only (used by the account-recovery Edge Function).
create or replace function public.set_recovery_code(p_user_id uuid, p_code text)
returns void language sql security definer set search_path = '' as $$
  insert into public.recovery_codes (user_id, code_hash, created_at, used_at)
  values (p_user_id, extensions.crypt(upper(p_code), extensions.gen_salt('bf', 10)), now(), null)
  on conflict (user_id) do update set code_hash = excluded.code_hash, created_at = now(), used_at = null;
$$;

create or replace function public.verify_recovery_code(p_email text, p_code text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare uid uuid;
begin
  select u.id into uid from auth.users u
    join public.recovery_codes rc on rc.user_id = u.id and rc.used_at is null
    where lower(u.email) = lower(trim(p_email))
      and rc.code_hash = extensions.crypt(upper(p_code), rc.code_hash);
  if uid is not null then
    update public.recovery_codes set used_at = now() where user_id = uid;
  end if;
  return uid;
end $$;

revoke all on function public.set_recovery_code(uuid, text) from public, anon, authenticated;
revoke all on function public.verify_recovery_code(text, text) from public, anon, authenticated;
revoke all on function public.consume_ai_quota(text, int, int) from public, anon;
revoke all on function public.log_meal_items(date, text, jsonb) from public, anon;
revoke all on function public.update_meal_item(uuid, text, jsonb) from public, anon;
revoke all on function public.recovery_code_status() from public, anon;
revoke all on function public.logged_dates(date) from public, anon;
grant execute on function public.logged_dates(date) to authenticated;
grant execute on function public.set_recovery_code(uuid, text) to service_role;
grant execute on function public.verify_recovery_code(text, text) to service_role;
grant execute on function public.consume_ai_quota(text, int, int) to authenticated, service_role;
grant execute on function public.log_meal_items(date, text, jsonb) to authenticated;
grant execute on function public.update_meal_item(uuid, text, jsonb) to authenticated;
grant execute on function public.recovery_code_status() to authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Realtime (cross-device sync). RLS applies to realtime subscribers too.
-- ───────────────────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      public.meal_items, public.weight_history, public.water_logs, public.activities,
      public.daily_goals, public.profiles, public.user_preferences;
  end if;
end $$;
