-- NutriLog — import data from the previous app version
--
-- The previous version stored rows in meals / user_settings / activities / weight_logs with a
-- text user_id. 001_initial_schema.sql renamed those tables to legacy_*.
--
-- Two import paths:
--   1. claim_legacy_data(tz)  — called by the app after sign-in. Moves legacy rows whose
--      user_id equals the caller's auth.uid(). This covers the old "Secure Mode", where the
--      app used an anonymous Supabase user: signing up from that browser upgrades the same
--      anonymous user, so its id (and data) carry over.
--   2. admin_import_legacy_user(legacy_id, user_id, tz) — for the old "legacy mode", where
--      data was keyed by a random device id. Only the project owner can run this, from the
--      Supabase SQL editor (see README → "Importing data from the old version").
--
-- Both are idempotent: rows keep their ids, so running them twice does not duplicate data.

create or replace function public._import_legacy(p_legacy_id text, p_user_id uuid, p_tz text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare tz text := coalesce(nullif(p_tz, ''), 'UTC');
declare n_items int := 0;
declare n_weights int := 0;
declare n_acts int := 0;
declare s record;
begin
  if p_user_id is null or p_legacy_id is null then raise exception 'missing ids'; end if;
  if not exists (select 1 from pg_timezone_names where name = tz) then tz := 'UTC'; end if;

  if to_regclass('public.legacy_meals') is not null then
    -- The old app had no meal types; infer one from the time the row was created.
    drop table if exists _legacy_items;
    create temporary table _legacy_items on commit drop as
      select m.*,
             case
               when extract(hour from (m.created_at at time zone 'UTC') at time zone tz) < 11 then 'breakfast'
               when extract(hour from (m.created_at at time zone 'UTC') at time zone tz) < 16 then 'lunch'
               when extract(hour from (m.created_at at time zone 'UTC') at time zone tz) < 18 then 'snack'
               else 'dinner'
             end as inferred_type
      from public.legacy_meals m
      where m.user_id = p_legacy_id and m.date is not null and coalesce(m.food_name, '') <> '';

    insert into public.meals (user_id, meal_date, meal_type)
      select distinct p_user_id, date, inferred_type from _legacy_items
      on conflict (user_id, meal_date, meal_type) do nothing;

    insert into public.meal_items (id, meal_id, user_id, meal_date, meal_type, food_name, source,
                                   quantity, unit, grams, calories, protein, carbs, fat, fiber, created_at)
      select li.id, ml.id, p_user_id, li.date, li.inferred_type, left(li.food_name, 200), 'legacy',
             1, left(coalesce(nullif(li.portion, ''), 'serving'), 60),
             case when li.portion ~* '^\s*\d+(\.\d+)?\s*g\s*$' then substring(li.portion from '(\d+(?:\.\d+)?)')::numeric end,
             greatest(coalesce(li.calories, 0), 0), greatest(coalesce(li.protein, 0), 0),
             greatest(coalesce(li.carbs, 0), 0), greatest(coalesce(li.fat, 0), 0), greatest(coalesce(li.fiber, 0), 0),
             coalesce(li.created_at at time zone 'UTC', now())
      from _legacy_items li
      join public.meals ml on ml.user_id = p_user_id and ml.meal_date = li.date and ml.meal_type = li.inferred_type
      on conflict (id) do nothing;
    get diagnostics n_items = row_count;

    delete from public.legacy_meals where user_id = p_legacy_id;
  end if;

  if to_regclass('public.legacy_weight_logs') is not null then
    insert into public.weight_history (user_id, recorded_on, weight_kg)
      select p_user_id, date, weight from public.legacy_weight_logs
      where user_id = p_legacy_id and weight between 20 and 400
      on conflict (user_id, recorded_on) do nothing;
    get diagnostics n_weights = row_count;
    delete from public.legacy_weight_logs where user_id = p_legacy_id;
  end if;

  if to_regclass('public.legacy_activities') is not null then
    insert into public.activities (id, user_id, activity_date, name, duration_min, calories_burned, source, created_at)
      select id, p_user_id, date, left(activity_name, 120), least(greatest(coalesce(duration_min, 0), 0), 1440),
             least(greatest(coalesce(calories_burned, 0), 0), 10000), 'legacy', coalesce(created_at at time zone 'UTC', now())
      from public.legacy_activities
      where user_id = p_legacy_id and coalesce(activity_name, '') <> ''
      on conflict (id) do nothing;
    get diagnostics n_acts = row_count;
    delete from public.legacy_activities where user_id = p_legacy_id;
  end if;

  if to_regclass('public.legacy_user_settings') is not null then
    select * into s from public.legacy_user_settings where user_id = p_legacy_id;
    if found then
      begin
        -- Old goals JSON: {"cal":2000,"prot":120,"carb":250,"fat":65,"fib":30}
        if s.goals is not null then
          update public.daily_goals g set
            calories  = least(greatest((s.goals::jsonb ->> 'cal')::numeric, 800), 10000)::int,
            protein_g = (s.goals::jsonb ->> 'prot')::numeric,
            carbs_g   = (s.goals::jsonb ->> 'carb')::numeric,
            fat_g     = (s.goals::jsonb ->> 'fat')::numeric,
            fiber_g   = (s.goals::jsonb ->> 'fib')::numeric,
            is_custom = true
          where g.user_id = p_user_id and g.calories is null;
        end if;
        -- Old body stats JSON: {"weight":70,"height":170,"age":25,"gender":"male","activityLevel":"sedentary"}
        if s.body_stats is not null then
          update public.profiles p set
            weight_kg      = coalesce(p.weight_kg, nullif((s.body_stats::jsonb ->> 'weight')::numeric, 0)),
            start_weight_kg = coalesce(p.start_weight_kg, nullif((s.body_stats::jsonb ->> 'weight')::numeric, 0)),
            height_cm      = coalesce(p.height_cm, nullif((s.body_stats::jsonb ->> 'height')::numeric, 0)),
            age            = coalesce(p.age, nullif((s.body_stats::jsonb ->> 'age')::numeric, 0)::smallint),
            sex            = coalesce(p.sex, case s.body_stats::jsonb ->> 'gender' when 'male' then 'male' when 'female' then 'female' end),
            activity_level = case when p.onboarding_completed then p.activity_level else
                               case s.body_stats::jsonb ->> 'activityLevel'
                                 when 'low_active' then 'light' when 'active' then 'moderate'
                                 when 'very_active' then 'active' else 'sedentary' end end
          where p.id = p_user_id;
        end if;
      exception when others then
        raise warning 'legacy settings for % could not be parsed: %', p_legacy_id, sqlerrm;
      end;
      delete from public.legacy_user_settings where user_id = p_legacy_id;
    end if;
  end if;

  return jsonb_build_object('meal_items', n_items, 'weights', n_weights, 'activities', n_acts);
end $$;

-- Called by the app for the signed-in user.
create or replace function public.claim_legacy_data(p_tz text default 'UTC')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  if to_regclass('public.legacy_meals') is null and to_regclass('public.legacy_weight_logs') is null
     and to_regclass('public.legacy_activities') is null and to_regclass('public.legacy_user_settings') is null then
    return jsonb_build_object('meal_items', 0, 'weights', 0, 'activities', 0);
  end if;
  return public._import_legacy(uid::text, uid, p_tz);
end $$;

-- Owner-only: move data saved under an old device id into a real account.
--   select public.admin_import_legacy_user('<old device id>', '<auth user id>', 'Asia/Kolkata');
create or replace function public.admin_import_legacy_user(p_legacy_id text, p_user_id uuid, p_tz text default 'UTC')
returns jsonb language sql security definer set search_path = '' as $$
  select public._import_legacy(p_legacy_id, p_user_id, p_tz);
$$;

revoke all on function public._import_legacy(text, uuid, text) from public, anon, authenticated;
revoke all on function public.admin_import_legacy_user(text, uuid, text) from public, anon, authenticated;
revoke all on function public.claim_legacy_data(text) from public, anon;
grant execute on function public.claim_legacy_data(text) to authenticated;
