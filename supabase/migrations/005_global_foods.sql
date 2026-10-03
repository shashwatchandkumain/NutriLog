-- NutriLog — the Global Food Database
--
-- ONE shared food database for every NutriLog user. A food is stored once (nutrition per 100 g,
-- servings, aliases, source); every user's log refers to it. Foods the app learns from AI start
-- as "pending" and become shared ("verified") only after strict checks — two different users
-- confirmed matching values — or an admin approves them. Users can never edit shared foods
-- directly: they submit candidates and correction requests, which these functions validate.
--
-- Privacy: the shared tables hold food information only. Who submitted or corrected what lives
-- in private tables that users can read only for themselves.

create extension if not exists pg_trgm with schema extensions;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Name matching: "Boiled Eggs" = "egg boiled" = "boiled egg" (same as js/lib/food-key.js)
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.food_key(p_name text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select coalesce(string_agg(w, ' ' order by w), '')
  from (
    select distinct (case
      when t ~ '(ss|us|is)$' then t
      when length(t) > 4 and t ~ 'ies$' then regexp_replace(t, 'ies$', 'y')
      when length(t) > 4 and t ~ '(ch|sh|x|o)es$' then regexp_replace(t, 'es$', '')
      when length(t) > 3 and t ~ 's$' then regexp_replace(t, 's$', '')
      else t end) collate "C" as w
    from regexp_split_to_table(regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', ' ', 'g'), ' ') as t
    where t <> '' and t not in ('a', 'an', 'the', 'of', 'and', 'with', 'some')
  ) words $$;

create or replace function public.try_uuid(p text)
returns uuid language plpgsql immutable set search_path = '' as $$
begin
  return p::uuid;
exception when others then
  return null;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Admins (who may approve foods and corrections)
-- ───────────────────────────────────────────────────────────────────────────
create table public.app_admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.app_admins enable row level security;
revoke all on public.app_admins from anon, authenticated;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_admins where user_id = (select auth.uid()))
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Shared tables
-- ───────────────────────────────────────────────────────────────────────────
create table public.foods (
  id               uuid primary key default gen_random_uuid(),
  name             text not null check (char_length(name) between 1 and 120),
  name_key         text not null check (char_length(name_key) between 1 and 120),
  parent_id        uuid references public.foods (id) on delete set null,
  category         text check (char_length(category) <= 40),
  preparation      text check (char_length(preparation) <= 40),
  description      text check (char_length(description) <= 300),
  base_unit        text not null default 'g' check (base_unit in ('g', 'ml')),
  -- per 100 g (or 100 ml); calories = 4·protein + 4·carbs + 9·fat, like everywhere in NutriLog
  calories         numeric(8, 2) not null check (calories between 0 and 902),
  protein          numeric(7, 2) not null check (protein between 0 and 100),
  carbs            numeric(7, 2) not null check (carbs between 0 and 100),
  fat              numeric(7, 2) not null check (fat between 0 and 100),
  fiber            numeric(7, 2) not null default 0 check (fiber between 0 and 100),
  sugar            numeric(7, 2) check (sugar between 0 and 100),
  saturated_fat    numeric(7, 2) check (saturated_fat between 0 and 100),
  trans_fat        numeric(7, 2) check (trans_fat between 0 and 100),
  sodium_mg        numeric(9, 2) check (sodium_mg between 0 and 40000),
  cholesterol_mg   numeric(8, 2) check (cholesterol_mg between 0 and 5000),
  -- vitamins and minerals per 100 g, e.g. {"iron_mg": 1.2}; a missing key means unknown, not zero
  micros           jsonb not null default '{}' check (jsonb_typeof(micros) = 'object'),
  source_type      text not null check (source_type in ('verified_source', 'external_database', 'ai_assisted', 'user_submitted', 'verified_admin', 'global_manual')),
  source           text check (char_length(source) <= 300),
  source_id        text check (char_length(source_id) <= 120),
  source_url       text check (char_length(source_url) <= 300),
  confidence       numeric(3, 2) check (confidence between 0 and 1),
  status           text not null default 'pending' check (status in ('pending', 'verified', 'rejected', 'needs_review')),
  version          integer not null default 1,
  merged_into      uuid references public.foods (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  last_verified_at timestamptz,
  check (protein + carbs + fat <= 100.5)
);
-- One live food per name: "Boiled egg" can't exist twice.
create unique index foods_live_name_key on public.foods (name_key) where status <> 'rejected' and merged_into is null;
create index foods_name_key_trgm on public.foods using gin (name_key extensions.gin_trgm_ops);
create index foods_status_idx on public.foods (status, category);
create index foods_source_id_idx on public.foods (source_id) where source_id is not null;

create table public.food_servings (
  id         uuid primary key default gen_random_uuid(),
  food_id    uuid not null references public.foods (id) on delete cascade,
  label      text not null check (char_length(label) between 1 and 60),
  grams      numeric(8, 2) not null check (grams > 0 and grams <= 5000),
  is_default boolean not null default false,
  sort_order smallint not null default 0
);
create index food_servings_food_idx on public.food_servings (food_id, sort_order);

create table public.food_aliases (
  alias_key  text primary key check (char_length(alias_key) between 1 and 80),
  alias      text not null check (char_length(alias) between 1 and 80),
  food_id    uuid not null references public.foods (id) on delete cascade,
  status     text not null default 'verified' check (status in ('verified')),
  created_at timestamptz not null default now()
);
create index food_aliases_food_idx on public.food_aliases (food_id);
create index food_aliases_key_trgm on public.food_aliases using gin (alias_key extensions.gin_trgm_ops);

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Private tables (never shared)
-- ───────────────────────────────────────────────────────────────────────────
-- Who confirmed a candidate food, and with what calories (to check that users agree).
create table public.food_submissions (
  food_id    uuid not null references public.foods (id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  calories   numeric(8, 2),
  created_at timestamptz not null default now(),
  primary key (food_id, user_id)
);
create index food_submissions_user_idx on public.food_submissions (user_id);

-- "anda" → Boiled egg, seen from different users before it becomes a shared alias.
create table public.food_alias_votes (
  alias_key  text not null,
  alias      text not null check (char_length(alias) between 1 and 80),
  food_id    uuid not null references public.foods (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (alias_key, food_id, user_id)
);

create table public.food_corrections (
  id          uuid primary key default gen_random_uuid(),
  food_id     uuid not null references public.foods (id) on delete cascade,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  suggested   jsonb not null check (jsonb_typeof(suggested) = 'object' and pg_column_size(suggested) < 2000),
  reason      text check (char_length(reason) <= 500),
  status      text not null default 'open' check (status in ('open', 'approved', 'rejected')),
  created_at  timestamptz not null default now(),
  reviewed_at timestamptz
);
create index food_corrections_open_idx on public.food_corrections (status, created_at);

-- Daily totals of how foods were resolved (no per-user data).
create table public.food_resolution_stats (
  day              date primary key,
  items            integer not null default 0,
  global_hits      integer not null default 0,
  external_hits    integer not null default 0,
  ai_items         integer not null default 0,
  ai_calls         integer not null default 0,
  ai_calls_avoided integer not null default 0
);

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Row Level Security
-- ───────────────────────────────────────────────────────────────────────────
alter table public.foods enable row level security;
alter table public.food_servings enable row level security;
alter table public.food_aliases enable row level security;
alter table public.food_submissions enable row level security;
alter table public.food_alias_votes enable row level security;
alter table public.food_corrections enable row level security;
alter table public.food_resolution_stats enable row level security;

revoke all on public.foods, public.food_servings, public.food_aliases, public.food_submissions,
  public.food_alias_votes, public.food_corrections, public.food_resolution_stats from anon;
-- Shared data is read-only for users; every change goes through the functions below.
revoke insert, update, delete, truncate on public.foods, public.food_servings, public.food_aliases,
  public.food_submissions, public.food_alias_votes, public.food_resolution_stats from authenticated;
revoke update, delete, truncate on public.food_corrections from authenticated;
revoke all on public.food_alias_votes, public.food_resolution_stats from authenticated;

-- Verified foods for everyone; a user also sees the candidates they submitted themselves.
create policy foods_read on public.foods for select to authenticated using (
  (status = 'verified' and merged_into is null)
  or exists (select 1 from public.food_submissions s where s.food_id = foods.id and s.user_id = (select auth.uid()))
  or (select public.is_admin())
);
create policy food_servings_read on public.food_servings for select to authenticated
  using (exists (select 1 from public.foods f where f.id = food_id));
create policy food_aliases_read on public.food_aliases for select to authenticated
  using (exists (select 1 from public.foods f where f.id = food_id));
create policy food_submissions_own on public.food_submissions for select to authenticated
  using ((select auth.uid()) = user_id);
create policy food_corrections_read on public.food_corrections for select to authenticated
  using ((select auth.uid()) = user_id or (select public.is_admin()));
create policy food_corrections_insert on public.food_corrections for insert to authenticated
  with check ((select auth.uid()) = user_id and status = 'open' and reviewed_at is null);

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Meal items and favorites refer to shared foods
-- ───────────────────────────────────────────────────────────────────────────
-- Logged items keep their own nutrition (the snapshot at logging time), so later improvements
-- to a shared food never change history.
alter table public.meal_items
  add column food_ref uuid references public.foods (id) on delete set null,
  add column food_version integer,
  add column micros jsonb check (micros is null or (jsonb_typeof(micros) = 'object' and pg_column_size(micros) < 4000));
alter table public.meal_items drop constraint meal_items_source_check;
alter table public.meal_items add constraint meal_items_source_check
  check (source in ('database', 'global', 'ai_text', 'ai_photo', 'barcode', 'manual', 'chat', 'legacy'));
create index meal_items_food_ref_idx on public.meal_items (food_ref) where food_ref is not null;

alter table public.favorite_foods add column food_ref uuid references public.foods (id) on delete set null;
create index favorite_foods_food_ref_idx on public.favorite_foods (food_ref) where food_ref is not null;

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
                                 quantity, unit, grams, calories, protein, carbs, fat, fiber, food_ref, food_version, micros)
  select coalesce((x ->> 'id')::uuid, gen_random_uuid()), v_meal_id, uid, p_meal_date, p_meal_type,
         nullif(x ->> 'food_id', ''), left(x ->> 'food_name', 200), coalesce(x ->> 'source', 'manual'),
         coalesce((x ->> 'quantity')::numeric, 1), left(coalesce(nullif(x ->> 'unit', ''), 'g'), 60),
         (x ->> 'grams')::numeric,
         round(coalesce((x ->> 'calories')::numeric, 0), 2), round(coalesce((x ->> 'protein')::numeric, 0), 2),
         round(coalesce((x ->> 'carbs')::numeric, 0), 2),    round(coalesce((x ->> 'fat')::numeric, 0), 2),
         round(coalesce((x ->> 'fiber')::numeric, 0), 2),
         f.id, f.version,                       -- only a food this user can see (RLS); else none
         case when jsonb_typeof(x -> 'micros') = 'object' then x -> 'micros' end
  from jsonb_array_elements(p_items) as x
  left join public.foods f on f.id = public.try_uuid(x ->> 'food_ref')
  on conflict (id) do nothing
  returning *;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. Reading: resolve names, search, barcodes
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.food_json(f public.foods)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', f.id, 'name', f.name, 'name_key', f.name_key, 'category', f.category, 'preparation', f.preparation,
    'base_unit', f.base_unit, 'calories', f.calories, 'protein', f.protein, 'carbs', f.carbs, 'fat', f.fat,
    'fiber', f.fiber, 'sugar', f.sugar, 'saturated_fat', f.saturated_fat, 'trans_fat', f.trans_fat,
    'sodium_mg', f.sodium_mg, 'cholesterol_mg', f.cholesterol_mg, 'micros', f.micros,
    'source_type', f.source_type, 'source', f.source, 'source_url', f.source_url, 'status', f.status, 'version', f.version,
    'servings', coalesce((select jsonb_agg(jsonb_build_object('label', s.label, 'grams', s.grams, 'is_default', s.is_default) order by s.sort_order, s.label)
                           from public.food_servings s where s.food_id = f.id), '[]'::jsonb))
$$;

/**
 * For each name: the food it matches exactly (name or alias), or up to 3 close candidates.
 * Runs with the caller's rights, so only foods they may see are returned.
 */
create or replace function public.resolve_foods(p_names text[])
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  out jsonb := '[]'::jsonb;
  n text;
  k text;
  hit jsonb;
  cands jsonb;
begin
  if p_names is null or array_length(p_names, 1) is null then return out; end if;
  if array_length(p_names, 1) > 25 then raise exception 'too many names' using errcode = '22023'; end if;
  foreach n in array p_names loop
    k := public.food_key(left(n, 120));
    hit := null; cands := '[]'::jsonb;
    if k <> '' then
      select jsonb_build_object('match', 'exact', 'food', public.food_json(f)) into hit
        from public.foods f where f.name_key = k and f.merged_into is null and f.status <> 'rejected'
        order by (f.status = 'verified') desc limit 1;
      if hit is null then
        select jsonb_build_object('match', 'alias', 'alias', a.alias, 'food', public.food_json(f)) into hit
          from public.food_aliases a join public.foods f on f.id = a.food_id
          where a.alias_key = k and f.merged_into is null and f.status <> 'rejected' limit 1;
      end if;
      if hit is null then
        select coalesce(jsonb_agg(jsonb_build_object('score', t.sc, 'food', public.food_json(f)) order by t.sc desc), '[]'::jsonb) into cands
        from (
          select m.id, max(m.sc) as sc from (
            select f2.id, extensions.similarity(f2.name_key, k) as sc
              from public.foods f2
              where f2.name_key operator(extensions.%) k and f2.merged_into is null and f2.status <> 'rejected'
            union all
            select a.food_id, extensions.similarity(a.alias_key, k)
              from public.food_aliases a where a.alias_key operator(extensions.%) k
          ) m group by m.id order by max(m.sc) desc limit 3
        ) t join public.foods f on f.id = t.id
        where f.merged_into is null and f.status <> 'rejected';
      end if;
    end if;
    out := out || jsonb_build_array(coalesce(hit, '{}'::jsonb) || jsonb_build_object('query', n, 'key', k, 'candidates', cands));
  end loop;
  return out;
end $$;

/** Search for the food pickers: name and alias matches first, then similar names. */
create or replace function public.search_foods(p_query text, p_limit integer default 20)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare k text := public.food_key(left(p_query, 80));
declare words text[];
begin
  if k = '' then return '[]'::jsonb; end if;
  words := string_to_array(k, ' ');
  return coalesce((
    select jsonb_agg(public.food_json(f) || jsonb_build_object('score', r.score) order by r.score desc, f.name)
    from (
      select m.id, max(m.score) as score from (
        select f1.id, case when f1.name_key = k then 3 else 1 + extensions.similarity(f1.name_key, k) end as score
          from public.foods f1
          where (select bool_and(f1.name_key like '%' || w || '%') from unnest(words) w)
        union all
        select a.food_id, case when a.alias_key = k then 2.5 else 0.9 + extensions.similarity(a.alias_key, k) end
          from public.food_aliases a
          where (select bool_and(a.alias_key like '%' || w || '%') from unnest(words) w)
        union all
        select f2.id, extensions.similarity(f2.name_key, k) from public.foods f2 where f2.name_key operator(extensions.%) k
      ) m group by m.id
      order by max(m.score) desc limit least(greatest(coalesce(p_limit, 20), 1), 50)
    ) r join public.foods f on f.id = r.id
    where f.merged_into is null and f.status <> 'rejected'
  ), '[]'::jsonb);
end $$;

/** A packaged food by its source id (e.g. 'off:8901234567890'). */
create or replace function public.food_by_source(p_source_id text)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select public.food_json(f) from public.foods f
  where f.source_id = left(p_source_id, 120) and f.merged_into is null and f.status <> 'rejected'
  order by (f.status = 'verified') desc limit 1
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 8. Writing: candidates, aliases, statistics
-- ───────────────────────────────────────────────────────────────────────────
/** Promotes a pending AI food once 2+ users confirmed it with calories within 15 % of each other. */
create or replace function public.food_check_promotion(p_food uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare f public.foods;
declare n int;
declare spread numeric;
begin
  select * into f from public.foods where id = p_food for update;
  if not found or f.status not in ('pending', 'needs_review') or f.source_type <> 'ai_assisted' then return f.status; end if;
  select count(*), coalesce(max(abs(s.calories - f.calories)) / greatest(f.calories, 1), 0)
    into n, spread from public.food_submissions s where s.food_id = p_food;
  if n >= 2 and spread > 0.15 then
    update public.foods set status = 'needs_review', updated_at = now() where id = p_food;
    return 'needs_review';
  end if;
  if f.status = 'pending' and n >= 2 and coalesce(f.confidence, 0) >= 0.7 then
    update public.foods set status = 'verified', last_verified_at = now(), updated_at = now() where id = p_food;
    return 'verified';
  end if;
  return f.status;
end $$;

/**
 * A user confirmed a food that wasn't in the database (from AI or a barcode). Validates every
 * value, never overwrites an existing food, and never stores who sent it in the shared table.
 * Returns { id, status } — status 'private' when the name looks personal ("my mom's curry").
 */
create or replace function public.submit_food(p_food jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  v_name text := btrim(regexp_replace(coalesce(p_food ->> 'name', ''), '\s+', ' ', 'g'));
  v_key text := public.food_key(v_name);
  v_type text := coalesce(p_food ->> 'source_type', 'ai_assisted');
  p numeric; c numeric; ft numeric; fib numeric; alc numeric; kcal numeric;
  v_conf numeric;
  v_micros jsonb := '{}'::jsonb;
  e record;
  f public.foods;
  v_id uuid;
  s jsonb;
  i int := 0;
begin
  if uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  if char_length(v_name) not between 2 and 80 or v_key = '' then raise exception 'invalid food name' using errcode = '22023'; end if;
  -- Personal recipes stay private.
  if regexp_replace(lower(v_name), '[^a-z ]', '', 'g') ~ '(^| )(my|mine|our|mom|moms|mommy|mummy|mother|maa|nani|dadi|grandma|granny|wife|husband|wifes|husbands)( |$)' then
    return jsonb_build_object('status', 'private');
  end if;
  if v_type not in ('ai_assisted', 'external_database') then raise exception 'invalid source' using errcode = '22023'; end if;

  begin
    p := (p_food ->> 'protein')::numeric; c := (p_food ->> 'carbs')::numeric; ft := (p_food ->> 'fat')::numeric;
    fib := coalesce((p_food ->> 'fiber')::numeric, 0); alc := coalesce((p_food ->> 'alcohol')::numeric, 0);
    v_conf := least(1, greatest(0, coalesce((p_food ->> 'confidence')::numeric, 0.5)));
  exception when others then
    raise exception 'invalid nutrition values' using errcode = '22023';
  end;
  if p is null or c is null or ft is null or least(p, c, ft, fib, alc) < 0 or greatest(p, c, ft, fib) > 100
     or p + c + ft + alc > 100.5 then
    raise exception 'invalid nutrition values' using errcode = '22023';
  end if;
  kcal := round(4 * p + 4 * c + 9 * ft + 7 * alc, 2);
  if kcal > 902 then raise exception 'invalid nutrition values' using errcode = '22023'; end if;
  -- Only known vitamin/mineral keys with sane numbers; anything else is dropped.
  if jsonb_typeof(p_food -> 'micros') = 'object' then
    for e in select key, value from jsonb_each(p_food -> 'micros') loop
      if e.key ~ '^(vitamin_(a|b[0-9]+|c|d|e|k)_(mg|ug)|(calcium|iron|magnesium|phosphorus|potassium|zinc|copper|manganese)_mg|selenium_ug)$'
         and jsonb_typeof(e.value) = 'number' and (e.value::text)::numeric between 0 and 100000 then
        v_micros := v_micros || jsonb_build_object(e.key, round((e.value::text)::numeric, 3));
      end if;
    end loop;
  end if;

  -- Already known (by name or alias)? Record the confirmation, never overwrite.
  select f2.* into f from public.foods f2
    where f2.merged_into is null and f2.status <> 'rejected'
      and (f2.name_key = v_key or f2.id = (select a.food_id from public.food_aliases a where a.alias_key = v_key))
    order by (f2.status = 'verified') desc limit 1;
  if found then
    if f.status <> 'verified' then
      insert into public.food_submissions (food_id, user_id, calories) values (f.id, uid, kcal) on conflict do nothing;
      return jsonb_build_object('id', f.id, 'status', public.food_check_promotion(f.id), 'existing', true);
    end if;
    return jsonb_build_object('id', f.id, 'status', f.status, 'existing', true);
  end if;

  insert into public.foods (name, name_key, category, preparation, base_unit, calories, protein, carbs, fat, fiber,
                            sugar, saturated_fat, sodium_mg, cholesterol_mg, micros, source_type, source, source_id,
                            source_url, confidence, status, last_verified_at)
  values (v_name, v_key, left(p_food ->> 'category', 40), left(p_food ->> 'preparation', 40),
          case when p_food ->> 'base_unit' = 'ml' then 'ml' else 'g' end,
          kcal, round(p, 2), round(c, 2), round(ft, 2), round(least(fib, c), 2),
          case when (p_food ->> 'sugar') ~ '^[0-9.]+$' then least((p_food ->> 'sugar')::numeric, c) end,
          case when (p_food ->> 'saturated_fat') ~ '^[0-9.]+$' then least((p_food ->> 'saturated_fat')::numeric, ft) end,
          case when (p_food ->> 'sodium_mg') ~ '^[0-9.]+$' then least((p_food ->> 'sodium_mg')::numeric, 40000) end,
          case when (p_food ->> 'cholesterol_mg') ~ '^[0-9.]+$' then least((p_food ->> 'cholesterol_mg')::numeric, 5000) end,
          v_micros, v_type,
          case when v_type = 'external_database' then left(coalesce(p_food ->> 'source', 'Open Food Facts'), 300) else 'AI estimate confirmed by NutriLog users' end,
          case when v_type = 'external_database' and (p_food ->> 'source_id') ~ '^off:[0-9]{6,14}$' then p_food ->> 'source_id' end,
          case when v_type = 'external_database' and (p_food ->> 'source_id') ~ '^off:[0-9]{6,14}$'
               then 'https://world.openfoodfacts.org/product/' || substr(p_food ->> 'source_id', 5) end,
          v_conf,
          -- Product-label data from a barcode database is shared at once; AI estimates wait for agreement.
          case when v_type = 'external_database' and (p_food ->> 'source_id') ~ '^off:[0-9]{6,14}$' then 'verified' else 'pending' end,
          case when v_type = 'external_database' and (p_food ->> 'source_id') ~ '^off:[0-9]{6,14}$' then now() end)
  returning id into v_id;

  if jsonb_typeof(p_food -> 'servings') = 'array' then
    for s in select value from jsonb_array_elements(p_food -> 'servings') limit 6 loop
      if char_length(btrim(coalesce(s ->> 'label', ''))) between 1 and 60 and (s ->> 'grams') ~ '^[0-9.]+$'
         and (s ->> 'grams')::numeric > 0 and (s ->> 'grams')::numeric <= 2000 then
        insert into public.food_servings (food_id, label, grams, is_default, sort_order)
          values (v_id, btrim(s ->> 'label'), round((s ->> 'grams')::numeric, 2), i = 0, i);
        i := i + 1;
      end if;
    end loop;
  end if;
  insert into public.food_submissions (food_id, user_id, calories) values (v_id, uid, kcal);
  return jsonb_build_object('id', v_id, 'status', (select status from public.foods where id = v_id), 'existing', false);
end $$;

/** "anda" was used for Boiled egg: becomes a shared alias once two different users used it. */
create or replace function public.propose_food_alias(p_alias text, p_food uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid();
declare v_alias text := btrim(left(coalesce(p_alias, ''), 80));
declare k text := public.food_key(v_alias);
begin
  if uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  if k = '' or char_length(k) < 2 or array_length(string_to_array(k, ' '), 1) > 4 then return 'ignored'; end if;
  if not exists (select 1 from public.foods where id = p_food and status = 'verified' and merged_into is null) then return 'ignored'; end if;
  if exists (select 1 from public.food_aliases where alias_key = k)
     or exists (select 1 from public.foods where name_key = k and status <> 'rejected' and merged_into is null) then return 'exists'; end if;
  insert into public.food_alias_votes (alias_key, alias, food_id, user_id) values (k, v_alias, p_food, uid) on conflict do nothing;
  if (select count(*) from public.food_alias_votes where alias_key = k and food_id = p_food) >= 2 then
    insert into public.food_aliases (alias_key, alias, food_id) values (k, v_alias, p_food) on conflict do nothing;
    delete from public.food_alias_votes where alias_key = k;
    return 'added';
  end if;
  return 'proposed';
end $$;

/** Counts how foods were resolved, for the AI-usage dashboard. */
create or replace function public.record_food_resolution(p_global int, p_external int, p_ai_items int, p_ai_calls int)
returns void language plpgsql security definer set search_path = '' as $$
declare g int := least(greatest(coalesce(p_global, 0), 0), 50);
declare x int := least(greatest(coalesce(p_external, 0), 0), 50);
declare a int := least(greatest(coalesce(p_ai_items, 0), 0), 50);
declare k int := least(greatest(coalesce(p_ai_calls, 0), 0), 5);
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  insert into public.food_resolution_stats as t (day, items, global_hits, external_hits, ai_items, ai_calls, ai_calls_avoided)
    values (current_date, g + x + a, g, x, a, k, g + x)
    on conflict (day) do update set items = t.items + excluded.items, global_hits = t.global_hits + excluded.global_hits,
      external_hits = t.external_hits + excluded.external_hits, ai_items = t.ai_items + excluded.ai_items,
      ai_calls = t.ai_calls + excluded.ai_calls, ai_calls_avoided = t.ai_calls_avoided + excluded.ai_calls_avoided;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 9. Admin
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.require_admin()
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'admins only' using errcode = '42501'; end if;
end $$;

create or replace function public.admin_overview()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.require_admin();
  return jsonb_build_object(
    'stats', coalesce((select jsonb_agg(to_jsonb(s) order by s.day desc) from (select * from public.food_resolution_stats order by day desc limit 30) s), '[]'::jsonb),
    'totals', (select jsonb_build_object('foods', count(*) filter (where status = 'verified' and merged_into is null),
                                         'pending', count(*) filter (where status in ('pending', 'needs_review') and merged_into is null))
               from public.foods),
    'queue', coalesce((select jsonb_agg(public.food_json(f) || jsonb_build_object('source_type', f.source_type, 'confidence', f.confidence, 'created_at', f.created_at,
                         'submissions', (select count(*) from public.food_submissions s where s.food_id = f.id)) order by f.created_at desc)
                       from public.foods f where f.status in ('pending', 'needs_review') and f.merged_into is null), '[]'::jsonb),
    'corrections', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'food_id', c.food_id, 'food', f.name, 'suggested', c.suggested,
                               'reason', c.reason, 'created_at', c.created_at,
                               'current', jsonb_build_object('calories', f.calories, 'protein', f.protein, 'carbs', f.carbs, 'fat', f.fat, 'fiber', f.fiber)) order by c.created_at)
                             from public.food_corrections c join public.foods f on f.id = c.food_id where c.status = 'open'), '[]'::jsonb),
    'aliases', coalesce((select jsonb_agg(x) from (
                           select jsonb_build_object('alias_key', v.alias_key, 'alias', min(v.alias), 'food_id', v.food_id, 'food', min(f.name), 'votes', count(*)) as x
                           from public.food_alias_votes v join public.foods f on f.id = v.food_id group by v.alias_key, v.food_id) a), '[]'::jsonb));
end $$;

create or replace function public.admin_set_food_status(p_food uuid, p_status text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_admin();
  if p_status not in ('pending', 'verified', 'rejected', 'needs_review') then raise exception 'invalid status' using errcode = '22023'; end if;
  update public.foods set status = p_status, updated_at = now(),
    last_verified_at = case when p_status = 'verified' then now() else last_verified_at end
  where id = p_food;
end $$;

/** Edits a shared food's values (a new version; logged meals keep their own numbers). */
create or replace function public.admin_update_food(p_food uuid, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare f public.foods;
declare p numeric; c numeric; ft numeric; fib numeric;
begin
  perform public.require_admin();
  select * into f from public.foods where id = p_food for update;
  if not found then raise exception 'food not found' using errcode = 'P0002'; end if;
  p := coalesce((p_patch ->> 'protein')::numeric, f.protein); c := coalesce((p_patch ->> 'carbs')::numeric, f.carbs);
  ft := coalesce((p_patch ->> 'fat')::numeric, f.fat); fib := coalesce((p_patch ->> 'fiber')::numeric, f.fiber);
  update public.foods set
    name = coalesce(nullif(btrim(p_patch ->> 'name'), ''), name),
    name_key = public.food_key(coalesce(nullif(btrim(p_patch ->> 'name'), ''), name)),
    category = coalesce(p_patch ->> 'category', category),
    preparation = coalesce(p_patch ->> 'preparation', preparation),
    protein = p, carbs = c, fat = ft, fiber = least(fib, c), calories = round(4 * p + 4 * c + 9 * ft, 2),
    source_type = case when p_patch ?| array['protein', 'carbs', 'fat', 'fiber'] then 'verified_admin' else source_type end,
    status = 'verified', version = version + 1, last_verified_at = now(), updated_at = now()
  where id = p_food returning * into f;
  return public.food_json(f);
end $$;

create or replace function public.admin_review_correction(p_id uuid, p_approve boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare c public.food_corrections;
begin
  perform public.require_admin();
  select * into c from public.food_corrections where id = p_id and status = 'open' for update;
  if not found then raise exception 'correction not found' using errcode = 'P0002'; end if;
  if p_approve then perform public.admin_update_food(c.food_id, c.suggested); end if;
  update public.food_corrections set status = case when p_approve then 'approved' else 'rejected' end, reviewed_at = now() where id = p_id;
end $$;

/** Merges a duplicate into the food that stays. Logged meals keep their nutrition. */
create or replace function public.admin_merge_foods(p_from uuid, p_into uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare f public.foods;
begin
  perform public.require_admin();
  if p_from = p_into then raise exception 'same food' using errcode = '22023'; end if;
  select * into f from public.foods where id = p_from for update;
  if not found or not exists (select 1 from public.foods where id = p_into and merged_into is null) then
    raise exception 'food not found' using errcode = 'P0002';
  end if;
  update public.meal_items set food_ref = p_into where food_ref = p_from;
  update public.favorite_foods set food_ref = p_into where food_ref = p_from;
  update public.food_aliases set food_id = p_into where food_id = p_from;
  insert into public.food_aliases (alias_key, alias, food_id) values (f.name_key, f.name, p_into) on conflict do nothing;
  insert into public.food_submissions (food_id, user_id, calories)
    select p_into, user_id, calories from public.food_submissions where food_id = p_from on conflict do nothing;
  update public.foods set merged_into = p_into, status = 'rejected', updated_at = now() where id = p_from;
end $$;

create or replace function public.admin_add_alias(p_food uuid, p_alias text)
returns void language plpgsql security definer set search_path = '' as $$
declare k text := public.food_key(left(p_alias, 80));
begin
  perform public.require_admin();
  if k = '' then raise exception 'invalid alias' using errcode = '22023'; end if;
  insert into public.food_aliases (alias_key, alias, food_id) values (k, btrim(left(p_alias, 80)), p_food)
    on conflict (alias_key) do update set food_id = excluded.food_id, alias = excluded.alias;
  delete from public.food_alias_votes where alias_key = k;
end $$;

create or replace function public.admin_reject_alias(p_alias_key text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_admin();
  delete from public.food_alias_votes where alias_key = p_alias_key;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 10. Grants
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.food_key(text)', 'public.try_uuid(text)', 'public.is_admin()', 'public.food_json(public.foods)',
    'public.resolve_foods(text[])', 'public.search_foods(text, integer)', 'public.food_by_source(text)',
    'public.submit_food(jsonb)', 'public.propose_food_alias(text, uuid)', 'public.record_food_resolution(integer, integer, integer, integer)',
    'public.admin_overview()', 'public.admin_set_food_status(uuid, text)', 'public.admin_update_food(uuid, jsonb)',
    'public.admin_review_correction(uuid, boolean)', 'public.admin_merge_foods(uuid, uuid)', 'public.admin_add_alias(uuid, text)',
    'public.admin_reject_alias(text)', 'public.log_meal_items(date, text, jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
  -- Internal helpers: not callable by clients.
  revoke all on function public.food_check_promotion(uuid) from public, anon, authenticated;
  revoke all on function public.require_admin() from public, anon, authenticated;
end $$;
