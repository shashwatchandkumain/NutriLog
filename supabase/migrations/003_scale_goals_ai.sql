-- NutriLog — smart scale, exact weights, goal dates, weight-based activity calories, AI choice
--
-- 1. Weigh-ins keep the scale's full 0.01 kg precision, where they came from, and a body
--    composition snapshot (estimated from weight + profile when measured) plus the heart rate
--    the scale reports.
-- 2. Profiles get a target date: targets are planned so the target weight is reached by then.
-- 3. Activities store their MET value. Calories burned are computed here from the user's weight
--    on the activity's date — and recomputed whenever weigh-ins change — so every device shows
--    the same exact number.
-- 4. Users choose which AI model (Gemini or Claude) estimates their food.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Weights
-- ───────────────────────────────────────────────────────────────────────────
alter table public.weight_history alter column weight_kg type numeric(6, 2);
alter table public.profiles
  alter column weight_kg type numeric(6, 2),
  alter column start_weight_kg type numeric(6, 2),
  alter column target_weight_kg type numeric(6, 2);

alter table public.weight_history
  add column source         text not null default 'manual' check (source in ('manual', 'scale', 'import', 'legacy')),
  add column measured_at    timestamptz,
  add column bmi            numeric(5, 2) check (bmi between 5 and 150),
  add column body_fat_pct   numeric(5, 2) check (body_fat_pct between 0 and 80),
  add column fat_mass_kg    numeric(6, 2) check (fat_mass_kg between 0 and 400),
  add column lean_mass_kg   numeric(6, 2) check (lean_mass_kg between 0 and 400),
  add column body_water_pct numeric(5, 2) check (body_water_pct between 0 and 100),
  add column body_water_l   numeric(6, 2) check (body_water_l between 0 and 300),
  add column bmr_kcal       numeric(7, 2) check (bmr_kcal between 0 and 10000),
  add column heart_rate_bpm smallint check (heart_rate_bpm between 30 and 230);

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Goal date
-- ───────────────────────────────────────────────────────────────────────────
alter table public.profiles add column target_date date;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Activities: net calories from MET × the weight on that day
-- ───────────────────────────────────────────────────────────────────────────
alter table public.activities
  alter column calories_burned type numeric(8, 2),
  add column met       numeric(5, 2) check (met between 1 and 25),
  add column weight_kg numeric(6, 2) check (weight_kg between 20 and 400);

-- The user's weight on a date: the latest weigh-in on or before it, else their earliest
-- weigh-in, else the profile weight. RLS applies (a user only ever sees their own weights).
create or replace function public.weight_on(p_user_id uuid, p_date date)
returns numeric language sql stable set search_path = '' as $$
  select coalesce(
    (select w.weight_kg from public.weight_history w
      where w.user_id = p_user_id and w.recorded_on <= p_date order by w.recorded_on desc limit 1),
    (select w.weight_kg from public.weight_history w
      where w.user_id = p_user_id order by w.recorded_on asc limit 1),
    (select p.weight_kg from public.profiles p where p.id = p_user_id));
$$;

-- Net energy above resting: (MET − 1) × kg × hours. Resting energy is already in BMR/TDEE.
create or replace function public.activities_net_calories()
returns trigger language plpgsql set search_path = '' as $$
declare w numeric;
begin
  if new.met is null then
    new.weight_kg := null;
    return new;
  end if;
  w := public.weight_on(new.user_id, new.activity_date);
  if w is not null then
    new.weight_kg := w;
    new.calories_burned := round(greatest(new.met - 1, 0) * w * new.duration_min / 60.0, 2);
  end if;
  return new;
end $$;

create trigger activities_net_calories before insert or update on public.activities
  for each row execute function public.activities_net_calories();

-- When a weigh-in is added, changed or removed, recompute the activities whose weight changed.
-- SECURITY DEFINER so it can skip work while an account is being deleted; it only ever touches
-- rows of the user who owns the weigh-in.
create or replace function public.weight_history_refresh_activities()
returns trigger language plpgsql security definer set search_path = '' as $$
declare uid uuid := coalesce(new.user_id, old.user_id);
begin
  if not exists (select 1 from auth.users u where u.id = uid) then return null; end if;
  update public.activities a set weight_kg = public.weight_on(uid, a.activity_date)
   where a.user_id = uid and a.met is not null
     and a.weight_kg is distinct from public.weight_on(uid, a.activity_date);
  return null;
end $$;

create trigger weight_history_refresh_activities after insert or update or delete on public.weight_history
  for each row execute function public.weight_history_refresh_activities();

revoke all on function public.weight_on(uuid, date) from public, anon;
grant execute on function public.weight_on(uuid, date) to authenticated, service_role;
revoke all on function public.weight_history_refresh_activities() from public, anon, authenticated;
revoke all on function public.activities_net_calories() from public, anon, authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. AI model preference
-- ───────────────────────────────────────────────────────────────────────────
alter table public.user_preferences
  add column ai_provider text not null default 'gemini' check (ai_provider in ('gemini', 'claude'));
