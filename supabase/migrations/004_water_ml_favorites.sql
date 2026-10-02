-- NutriLog — water in millilitres, favorite foods
--
-- 1. Water is tracked in millilitres (quick adds of 250 / 500 / 750 / 1000 ml or any amount).
--    The old `glasses` columns stay and are kept in sync both ways by triggers, so an app
--    version that still writes glasses (e.g. a cached copy on another device) keeps working.
-- 2. Favorite foods: a user's own saved foods (name, portion and nutrition for that portion)
--    for one-tap logging. Private to the user like every other table.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Water
-- ───────────────────────────────────────────────────────────────────────────
alter table public.water_logs add column ml integer not null default 0 check (ml between 0 and 20000);
update public.water_logs set ml = glasses * 250;

alter table public.user_preferences
  add column water_goal_ml integer not null default 2000 check (water_goal_ml between 250 and 10000);
update public.user_preferences set water_goal_ml = water_goal * 250;

-- Whichever unit a client wrote wins; the other is derived from it (1 glass = 250 ml).
create or replace function public.water_logs_sync_units()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.ml = 0 and new.glasses > 0 then new.ml := new.glasses * 250; end if;
  elsif new.ml is distinct from old.ml then
    null; -- ml changed: glasses follows below
  elsif new.glasses is distinct from old.glasses then
    new.ml := new.glasses * 250;
  end if;
  new.glasses := least(40, round(new.ml / 250.0))::smallint;
  return new;
end $$;

create trigger water_logs_sync_units before insert or update on public.water_logs
  for each row execute function public.water_logs_sync_units();

create or replace function public.user_preferences_sync_water_goal()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.water_goal is distinct from old.water_goal and new.water_goal_ml is not distinct from old.water_goal_ml then
    new.water_goal_ml := least(10000, new.water_goal * 250);
  end if;
  new.water_goal := greatest(1, least(30, round(new.water_goal_ml / 250.0)))::smallint;
  return new;
end $$;

create trigger user_preferences_sync_water_goal before insert or update on public.user_preferences
  for each row execute function public.user_preferences_sync_water_goal();

revoke all on function public.water_logs_sync_units() from public, anon, authenticated;
revoke all on function public.user_preferences_sync_water_goal() from public, anon, authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Favorite foods
-- ───────────────────────────────────────────────────────────────────────────
create table public.favorite_foods (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  food_name  text not null check (char_length(food_name) between 1 and 200),
  quantity   numeric(10, 2) not null default 1 check (quantity > 0 and quantity <= 10000),
  unit       text not null default 'g' check (char_length(unit) between 1 and 60),
  grams      numeric(10, 2) check (grams >= 0 and grams <= 20000),
  calories   numeric(10, 2) not null check (calories between 0 and 20000),
  protein    numeric(10, 2) not null default 0 check (protein between 0 and 2000),
  carbs      numeric(10, 2) not null default 0 check (carbs between 0 and 2000),
  fat        numeric(10, 2) not null default 0 check (fat between 0 and 2000),
  fiber      numeric(10, 2) not null default 0 check (fiber between 0 and 2000),
  created_at timestamptz not null default now(),
  unique (user_id, food_name, unit)
);

create index favorite_foods_user_idx on public.favorite_foods (user_id, created_at);

alter table public.favorite_foods enable row level security;
revoke all on public.favorite_foods from anon;
create policy favorites_all on public.favorite_foods for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.favorite_foods;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Logged items can be renamed (e.g. to correct an AI name)
-- ───────────────────────────────────────────────────────────────────────────
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
    meal_id   = v_meal_id,
    food_name = coalesce(left(nullif(trim(p_patch ->> 'food_name'), ''), 200), food_name),
    quantity  = coalesce((p_patch ->> 'quantity')::numeric, quantity),
    unit      = coalesce(left(nullif(p_patch ->> 'unit', ''), 60), unit),
    grams     = coalesce((p_patch ->> 'grams')::numeric, grams),
    calories  = coalesce(round((p_patch ->> 'calories')::numeric, 2), calories),
    protein   = coalesce(round((p_patch ->> 'protein')::numeric, 2), protein),
    carbs     = coalesce(round((p_patch ->> 'carbs')::numeric, 2), carbs),
    fat       = coalesce(round((p_patch ->> 'fat')::numeric, 2), fat),
    fiber     = coalesce(round((p_patch ->> 'fiber')::numeric, 2), fiber)
  where id = p_id and user_id = uid
  returning * into item;
  return item;
end $$;

revoke all on function public.update_meal_item(uuid, text, jsonb) from public, anon;
grant execute on function public.update_meal_item(uuid, text, jsonb) to authenticated;
