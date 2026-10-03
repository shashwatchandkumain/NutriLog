-- NutriLog — subscriptions, AI credits, phone numbers and the free trial
--
-- Plans (free / pro / pro_ai), their prices and AI-credit allowances live in tables, so prices,
-- limits and features change without touching code. Payments are Razorpay subscriptions: the
-- billing Edge Function creates them and the Razorpay webhook keeps them up to date — users can
-- read their own billing rows but never write them. AI credits are spent only by the Edge
-- Functions (service role). The one-week Pro AI trial can be claimed once per phone number and
-- once per email, ever: the claim ledger keeps only hashes and survives account deletion.
-- Admin is a role (public.app_admins), not a plan.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Plans, prices, credit costs
-- ───────────────────────────────────────────────────────────────────────────
create table public.plans (
  id              text primary key check (id in ('free', 'pro', 'pro_ai')),
  name            text not null,
  rank            smallint not null unique,
  credits_monthly integer not null check (credits_monthly between 0 and 100000),
  trial_credits   integer not null default 0 check (trial_credits between 0 and 100000),
  -- feature flags, e.g. {"claude": true}; a missing key means "not included"
  features        jsonb not null default '{}' check (jsonb_typeof(features) = 'object')
);
insert into public.plans (id, name, rank, credits_monthly, trial_credits, features) values
  ('free',   'Free',   0, 20,  0,   '{"history_days": 30}'),
  ('pro',    'Pro',    1, 150, 0,   '{"weekly_report": true, "micros": true, "body_history": true}'),
  ('pro_ai', 'Pro AI', 2, 600, 150, '{"weekly_report": true, "micros": true, "body_history": true, "claude": true, "meal_plan": true}');

-- Prices in paise, before GST. list = the crossed-out price; price = what is charged (+ GST).
create table public.plan_prices (
  plan_id     text not null references public.plans (id) on delete cascade,
  period      text not null check (period in ('month', 'year')),
  list_paise  integer not null check (list_paise > 0),
  price_paise integer not null check (price_paise > 0 and price_paise <= list_paise),
  gst_rate    numeric(4, 3) not null default 0.18 check (gst_rate between 0 and 0.5),
  -- Razorpay plan ids per mode ({"test": "plan_…", "live": "plan_…"}), created by billing → sync_plans
  razorpay_plan_ids jsonb not null default '{}' check (jsonb_typeof(razorpay_plan_ids) = 'object'),
  active      boolean not null default true,
  primary key (plan_id, period)
);
insert into public.plan_prices (plan_id, period, list_paise, price_paise) values
  ('pro',    'month', 29900,  14900),
  ('pro',    'year',  358800, 99900),
  ('pro_ai', 'month', 60000,  29900),
  ('pro_ai', 'year',  720000, 199900);

-- What each AI action costs in credits. Foods found in the Global Food Database cost nothing.
create table public.ai_credit_costs (
  action  text primary key check (char_length(action) <= 40),
  credits integer not null check (credits between 0 and 100),
  label   text not null
);
insert into public.ai_credit_costs (action, credits, label) values
  ('food_parse',      1,  'Understanding a typed or spoken meal'),
  ('food_estimate',   1,  'Estimating foods the database doesn''t know'),
  ('food_text',       2,  'Analysing a meal description'),
  ('food_image',      5,  'Analysing a food photo'),
  ('activity',        1,  'Estimating an activity'),
  ('chat',            1,  'Coach message'),
  ('day_review',      1,  'Review my day'),
  ('suggest_meal',    1,  'Suggest what to eat next'),
  ('weekly_report',   10, 'Weekly AI report'),
  ('meal_plan_day',   5,  'AI meal plan (1 day)'),
  ('meal_plan_week',  10, 'AI meal plan (7 days) + grocery list');

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Subscriptions, grants, credits, trial ledger
-- ───────────────────────────────────────────────────────────────────────────
create table public.billing_subscriptions (
  id                  text primary key check (char_length(id) between 4 and 60),  -- Razorpay subscription id
  user_id             uuid not null references auth.users (id) on delete cascade,
  plan_id             text not null references public.plans (id),
  period              text not null check (period in ('month', 'year')),
  is_trial            boolean not null default false,
  status              text not null check (status in ('created', 'authenticated', 'active', 'pending', 'halted', 'paused', 'cancelled', 'completed', 'expired')),
  start_at            timestamptz,
  current_start       timestamptz,
  current_end         timestamptz,
  ended_at            timestamptz,
  cancel_at_cycle_end boolean not null default false,
  mode                text not null check (mode in ('test', 'live')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index billing_subscriptions_user_idx on public.billing_subscriptions (user_id, status);

-- Plans given by an admin (e.g. a free month for a tester).
create table public.plan_grants (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  plan_id    text not null references public.plans (id),
  ends_at    timestamptz not null,
  note       text check (char_length(note) <= 200),
  created_at timestamptz not null default now()
);

create table public.ai_credit_usage (
  user_id    uuid not null references auth.users (id) on delete cascade,
  period_key text not null check (char_length(period_key) <= 80),  -- 'm:2026-10' or 't:<trial subscription id>'
  used       integer not null default 0 check (used >= 0),
  bonus      integer not null default 0 check (bonus >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, period_key)
);

-- One trial per phone and per email, forever. Only hashes are kept; the row outlives the account.
create table public.trial_claims (
  phone_hash      text primary key,
  email_hash      text not null unique,
  user_id         uuid references auth.users (id) on delete set null,
  subscription_id text,
  claimed_at      timestamptz not null default now()
);

create table public.billing_events (
  id          text primary key,  -- Razorpay event id (x-razorpay-event-id)
  event       text not null,
  received_at timestamptz not null default now(),
  payload     jsonb not null
);

-- Saved AI reports and meal plans (each user's own).
create table public.ai_reports (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind       text not null check (kind in ('weekly_report', 'meal_plan')),
  params     jsonb not null default '{}',
  content    jsonb not null check (pg_column_size(content) < 60000),
  created_at timestamptz not null default now()
);
create index ai_reports_user_idx on public.ai_reports (user_id, kind, created_at desc);

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Phone numbers (primary contact). Verified only through Supabase Auth (WhatsApp OTP).
-- ───────────────────────────────────────────────────────────────────────────
alter table public.profiles
  add column phone text check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  add column phone_verified boolean not null default false;

-- phone_verified can't be set by the user: it's true only when Supabase Auth confirmed this number.
create or replace function public.profiles_phone_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.phone_verified := new.phone is not null and exists (
    select 1 from auth.users u where u.id = new.id and u.phone = ltrim(new.phone, '+') and u.phone_confirmed_at is not null);
  return new;
end $$;
create trigger profiles_phone_guard before insert or update of phone, phone_verified on public.profiles
  for each row execute function public.profiles_phone_guard();

-- When Supabase Auth confirms a phone, copy it to the profile.
create or replace function public.auth_phone_confirmed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.phone is not null and new.phone <> '' and new.phone_confirmed_at is not null
     and (old.phone_confirmed_at is distinct from new.phone_confirmed_at or old.phone is distinct from new.phone) then
    update public.profiles set phone = '+' || new.phone where id = new.id;
  end if;
  return new;
end $$;
drop trigger if exists on_auth_phone_confirmed on auth.users;
create trigger on_auth_phone_confirmed after update of phone, phone_confirmed_at on auth.users
  for each row execute function public.auth_phone_confirmed();

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Row Level Security
-- ───────────────────────────────────────────────────────────────────────────
alter table public.plans enable row level security;
alter table public.plan_prices enable row level security;
alter table public.ai_credit_costs enable row level security;
alter table public.billing_subscriptions enable row level security;
alter table public.plan_grants enable row level security;
alter table public.ai_credit_usage enable row level security;
alter table public.trial_claims enable row level security;
alter table public.billing_events enable row level security;
alter table public.ai_reports enable row level security;

revoke all on public.plans, public.plan_prices, public.ai_credit_costs, public.billing_subscriptions, public.plan_grants,
  public.ai_credit_usage, public.trial_claims, public.billing_events, public.ai_reports from anon;
revoke insert, update, delete, truncate on public.plans, public.plan_prices, public.ai_credit_costs, public.billing_subscriptions,
  public.plan_grants, public.ai_credit_usage from authenticated;
revoke all on public.trial_claims, public.billing_events from authenticated;
revoke update, truncate on public.ai_reports from authenticated;

create policy plans_read on public.plans for select to authenticated using (true);
create policy plan_prices_read on public.plan_prices for select to authenticated using (active);
create policy ai_credit_costs_read on public.ai_credit_costs for select to authenticated using (true);
create policy billing_subscriptions_own on public.billing_subscriptions for select to authenticated using ((select auth.uid()) = user_id);
create policy plan_grants_own on public.plan_grants for select to authenticated using ((select auth.uid()) = user_id);
create policy ai_credit_usage_own on public.ai_credit_usage for select to authenticated using ((select auth.uid()) = user_id);
create policy ai_reports_select on public.ai_reports for select to authenticated using ((select auth.uid()) = user_id);
create policy ai_reports_insert on public.ai_reports for insert to authenticated with check ((select auth.uid()) = user_id);
create policy ai_reports_delete on public.ai_reports for delete to authenticated using ((select auth.uid()) = user_id);

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.billing_subscriptions, public.plan_grants;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Entitlements: which plan a user has right now, and their AI credits
-- ───────────────────────────────────────────────────────────────────────────
/**
 * { plan, plan_name, source: free|trial|subscription|grant, status, period, subscription_id,
 *   ends_at, trial_end, cancel_at_period_end, features, credits: { allowance, used, remaining,
 *   resets_at, period_key } }
 */
create or replace function public.entitlement_for(p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  best_plan text := 'free'; best_rank int := 0; src text := 'free'; st text := null; per text := null; sub_id text := null;
  ends timestamptz := null; trial_end timestamptz := null; cancel boolean := false;
  r record; g record; p public.plans; rk int; cand_end timestamptz;
  k text; resets timestamptz; u public.ai_credit_usage; allowance int; ist timestamp;
begin
  for r in select * from public.billing_subscriptions where user_id = p_user loop
    -- Trial: Pro AI from the mandate until the first charge (also if cancelled during the trial).
    if r.is_trial and r.start_at > now() and r.status in ('authenticated', 'active', 'cancelled') then
      select rank into rk from public.plans where id = 'pro_ai';
      if rk > best_rank or (rk = best_rank and src = 'free') then
        best_plan := 'pro_ai'; best_rank := rk; src := 'trial'; st := 'trialing'; per := r.period; sub_id := r.id;
        ends := r.start_at; trial_end := r.start_at; cancel := r.status = 'cancelled' or r.cancel_at_cycle_end;
      end if;
      continue;
    end if;
    cand_end := coalesce(r.current_end, case when r.status = 'active' then now() + interval '1 day' end);
    if (r.status in ('active', 'authenticated') and cand_end > now())
       or (r.status = 'pending' and cand_end > now() - interval '3 days')            -- payment retrying: 3-day grace
       or (r.status = 'cancelled' and r.current_end > now()) then                       -- cancelled: until the period ends
      select rank into rk from public.plans where id = r.plan_id;
      if rk > best_rank or (rk = best_rank and src in ('free', 'grant')) then
        best_plan := r.plan_id; best_rank := rk; src := 'subscription'; sub_id := r.id; per := r.period;
        st := case when r.status = 'pending' then 'past_due' when r.status = 'cancelled' or r.cancel_at_cycle_end then 'cancelling' else 'active' end;
        ends := r.current_end; trial_end := null; cancel := r.status = 'cancelled' or r.cancel_at_cycle_end;
      end if;
    end if;
  end loop;
  select * into g from public.plan_grants where user_id = p_user and ends_at > now();
  if found then
    select rank into rk from public.plans where id = g.plan_id;
    if rk > best_rank then
      best_plan := g.plan_id; best_rank := rk; src := 'grant'; st := 'active'; ends := g.ends_at; per := null; sub_id := null; trial_end := null; cancel := false;
    end if;
  end if;

  select * into p from public.plans where id = best_plan;
  if src = 'trial' then
    k := 't:' || sub_id; resets := trial_end; allowance := p.trial_credits;
  else
    ist := now() at time zone 'Asia/Kolkata';
    k := 'm:' || to_char(ist, 'YYYY-MM');
    resets := (date_trunc('month', ist) + interval '1 month') at time zone 'Asia/Kolkata';
    allowance := p.credits_monthly;
  end if;
  select * into u from public.ai_credit_usage where user_id = p_user and period_key = k;
  allowance := allowance + coalesce(u.bonus, 0);
  return jsonb_build_object(
    'plan', p.id, 'plan_name', p.name, 'source', src, 'status', coalesce(st, 'free'), 'period', per, 'subscription_id', sub_id,
    'ends_at', ends, 'trial_end', trial_end, 'cancel_at_period_end', cancel, 'features', p.features,
    'credits', jsonb_build_object('allowance', allowance, 'used', coalesce(u.used, 0),
      'remaining', greatest(allowance - coalesce(u.used, 0), 0), 'resets_at', resets, 'period_key', k));
end $$;

create or replace function public.my_entitlement()
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.entitlement_for((select auth.uid()))
$$;

/** Spends AI credits for an action (Edge Functions only). → { ok, cost, remaining, plan, features, period_key } */
create or replace function public.consume_credits(p_user uuid, p_action text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare e jsonb; c int; k text; allowance int; new_used int;
begin
  select credits into c from public.ai_credit_costs where action = p_action;
  if c is null then raise exception 'unknown action %', p_action using errcode = '22023'; end if;
  e := public.entitlement_for(p_user);
  k := e -> 'credits' ->> 'period_key';
  allowance := (e -> 'credits' ->> 'allowance')::int;
  insert into public.ai_credit_usage (user_id, period_key) values (p_user, k) on conflict do nothing;
  update public.ai_credit_usage set used = used + c, updated_at = now()
    where user_id = p_user and period_key = k and used + c <= allowance
    returning used into new_used;
  if new_used is null then
    return jsonb_build_object('ok', false, 'cost', c, 'remaining', (e -> 'credits' ->> 'remaining')::int, 'plan', e ->> 'plan',
      'features', e -> 'features', 'period_key', k, 'resets_at', e -> 'credits' -> 'resets_at');
  end if;
  return jsonb_build_object('ok', true, 'cost', c, 'remaining', allowance - new_used, 'plan', e ->> 'plan', 'features', e -> 'features', 'period_key', k);
end $$;

/** Gives credits back when the AI call failed (Edge Functions only). */
create or replace function public.refund_credits(p_user uuid, p_period_key text, p_credits int)
returns void language sql security definer set search_path = '' as $$
  update public.ai_credit_usage set used = greatest(used - least(greatest(p_credits, 0), 100), 0), updated_at = now()
  where user_id = p_user and period_key = p_period_key
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Trial eligibility (one per phone and per email, ever)
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.contact_hash(p_kind text, p_value text)
returns text language sql immutable set search_path = '' as $$
  select encode(extensions.digest('nutrilog-trial:' || p_kind || ':' || lower(btrim(coalesce(p_value, ''))), 'sha256'), 'hex')
$$;

/** { eligible, reason } — reason: no_phone | phone_unverified | phone_used | email_used | already_subscribed */
create or replace function public.trial_eligibility_for(p_user uuid, p_require_verified boolean)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare pr public.profiles; em text;
begin
  select * into pr from public.profiles where id = p_user;
  select email into em from auth.users where id = p_user;
  if pr.phone is null then return jsonb_build_object('eligible', false, 'reason', 'no_phone'); end if;
  if p_require_verified and not pr.phone_verified then return jsonb_build_object('eligible', false, 'reason', 'phone_unverified'); end if;
  if exists (select 1 from public.trial_claims where phone_hash = public.contact_hash('phone', pr.phone)) then
    return jsonb_build_object('eligible', false, 'reason', 'phone_used');
  end if;
  if em is not null and exists (select 1 from public.trial_claims where email_hash = public.contact_hash('email', em)) then
    return jsonb_build_object('eligible', false, 'reason', 'email_used');
  end if;
  if exists (select 1 from public.billing_subscriptions where user_id = p_user and status <> 'created') then
    return jsonb_build_object('eligible', false, 'reason', 'already_subscribed');
  end if;
  return jsonb_build_object('eligible', true, 'reason', null);
end $$;

create or replace function public.claim_trial(p_user uuid, p_subscription text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare pr public.profiles; em text;
begin
  select * into pr from public.profiles where id = p_user;
  select email into em from auth.users where id = p_user;
  if pr.phone is null then return false; end if;
  insert into public.trial_claims (phone_hash, email_hash, user_id, subscription_id)
    values (public.contact_hash('phone', pr.phone), public.contact_hash('email', coalesce(em, p_user::text)), p_user, p_subscription);
  return true;
exception when unique_violation then
  return false;
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 7. Admin (users, plans, credits, billing overview)
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.admin_users(p_query text default '', p_limit int default 30)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare q text := lower(btrim(coalesce(p_query, '')));
begin
  perform public.require_admin();
  return coalesce((
    select jsonb_agg(x order by x ->> 'created_at' desc) from (
      select jsonb_build_object('id', u.id, 'email', u.email, 'phone', p.phone, 'phone_verified', p.phone_verified,
        'name', p.display_name, 'created_at', u.created_at, 'last_sign_in_at', u.last_sign_in_at,
        'admin', exists (select 1 from public.app_admins a where a.user_id = u.id),
        'entitlement', public.entitlement_for(u.id)) as x
      from auth.users u left join public.profiles p on p.id = u.id
      where q = '' or lower(coalesce(u.email, '')) like '%' || q || '%' or coalesce(p.phone, '') like '%' || q || '%'
         or lower(coalesce(p.display_name, '')) like '%' || q || '%'
      order by u.created_at desc
      limit least(greatest(coalesce(p_limit, 30), 1), 100)
    ) t), '[]'::jsonb);
end $$;

create or replace function public.admin_grant_plan(p_user uuid, p_plan text, p_days int, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_admin();
  if p_plan not in ('pro', 'pro_ai') or p_days not between 1 and 3660 then raise exception 'invalid grant' using errcode = '22023'; end if;
  insert into public.plan_grants (user_id, plan_id, ends_at, note) values (p_user, p_plan, now() + make_interval(days => p_days), left(p_note, 200))
    on conflict (user_id) do update set plan_id = excluded.plan_id, ends_at = excluded.ends_at, note = excluded.note, created_at = now();
end $$;

create or replace function public.admin_end_grant(p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.require_admin();
  delete from public.plan_grants where user_id = p_user;
end $$;

create or replace function public.admin_add_credits(p_user uuid, p_credits int)
returns void language plpgsql security definer set search_path = '' as $$
declare k text;
begin
  perform public.require_admin();
  if p_credits not between 1 and 10000 then raise exception 'invalid amount' using errcode = '22023'; end if;
  k := public.entitlement_for(p_user) -> 'credits' ->> 'period_key';
  insert into public.ai_credit_usage (user_id, period_key, bonus) values (p_user, k, p_credits)
    on conflict (user_id, period_key) do update set bonus = public.ai_credit_usage.bonus + excluded.bonus, updated_at = now();
end $$;

create or replace function public.admin_billing_overview()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare by_plan jsonb; mrr numeric := 0; r record; e jsonb;
begin
  perform public.require_admin();
  by_plan := jsonb_build_object('free', 0, 'pro', 0, 'pro_ai', 0, 'trialing', 0, 'past_due', 0);
  for r in select id from auth.users loop
    e := public.entitlement_for(r.id);
    by_plan := jsonb_set(by_plan, array[e ->> 'plan'], to_jsonb((by_plan ->> (e ->> 'plan'))::int + 1));
    if e ->> 'status' = 'trialing' then by_plan := jsonb_set(by_plan, '{trialing}', to_jsonb((by_plan ->> 'trialing')::int + 1)); end if;
    if e ->> 'status' = 'past_due' then by_plan := jsonb_set(by_plan, '{past_due}', to_jsonb((by_plan ->> 'past_due')::int + 1)); end if;
    if e ->> 'source' = 'subscription' then
      select mrr + case when pp.period = 'year' then pp.price_paise / 12.0 else pp.price_paise end / 100.0 into mrr
        from public.plan_prices pp where pp.plan_id = e ->> 'plan' and pp.period = e ->> 'period';
    end if;
  end loop;
  return jsonb_build_object('users', by_plan, 'mrr_rupees', round(mrr), 'credits_this_month',
    (select coalesce(sum(used), 0) from public.ai_credit_usage where period_key = 'm:' || to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM')),
    'recent', coalesce((select jsonb_agg(jsonb_build_object('event', b.event, 'at', b.received_at) order by b.received_at desc)
                        from (select * from public.billing_events order by received_at desc limit 15) b), '[]'::jsonb));
end $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 8. Grants
-- ───────────────────────────────────────────────────────────────────────────
do $$
declare fn text;
begin
  foreach fn in array array['public.my_entitlement()', 'public.admin_users(text, integer)', 'public.admin_grant_plan(uuid, text, integer, text)',
    'public.admin_end_grant(uuid)', 'public.admin_add_credits(uuid, integer)', 'public.admin_billing_overview()'] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
  -- Server-only: spending/refunding credits, trial checks and claims.
  foreach fn in array array['public.entitlement_for(uuid)', 'public.consume_credits(uuid, text)', 'public.refund_credits(uuid, text, integer)',
    'public.trial_eligibility_for(uuid, boolean)', 'public.claim_trial(uuid, text)', 'public.contact_hash(text, text)',
    'public.profiles_phone_guard()', 'public.auth_phone_confirmed()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;
