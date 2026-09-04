-- Purchased contact credits that do not expire. Applied to production
-- 2026-09-04. See netlify/functions/lib/topups.js for the pricing reasoning.
--
-- The monthly allowance resets on the first. A top-up does not — and that is
-- cash-positive rather than generous: Annie is paid at purchase but only pays
-- Apollo when a credit is actually used, so an unspent balance costs nothing to
-- carry, while expiry would generate support tickets over pennies.

create table if not exists public.contact_credit_topups (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null,
  user_id uuid,
  credits integer not null check (credits > 0),
  amount_cents integer,
  currency text,
  pack_key text,
  stripe_session_id text unique,
  created_at timestamptz not null default now()
);
create index if not exists contact_credit_topups_team_idx on public.contact_credit_topups (team_id);
alter table public.contact_credit_topups enable row level security;
drop policy if exists contact_credit_topups_select_own_team on public.contact_credit_topups;
create policy contact_credit_topups_select_own_team on public.contact_credit_topups for select
  using (team_id in (select tm.team_id from public.team_members tm where tm.user_id = auth.uid() and tm.status = 'active'));

create table if not exists public.contact_credit_topup_usage (
  team_id uuid primary key,
  credits_used integer not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.contact_credit_topup_usage enable row level security;
drop policy if exists contact_credit_topup_usage_select_own_team on public.contact_credit_topup_usage;
create policy contact_credit_topup_usage_select_own_team on public.contact_credit_topup_usage for select
  using (team_id in (select tm.team_id from public.team_members tm where tm.user_id = auth.uid() and tm.status = 'active'));

create or replace function public.contact_credits_topup_balance(p_team_id uuid)
returns integer language sql security definer set search_path to 'public' as $function$
  select greatest(0,
    coalesce((select sum(credits) from public.contact_credit_topups where team_id = p_team_id), 0)
    - coalesce((select credits_used from public.contact_credit_topup_usage where team_id = p_team_id), 0)
  )::integer;
$function$;

-- Idempotent on the Stripe session id: Stripe retries this webhook on any
-- non-2xx and on its own schedule, and a customer must never be granted the
-- same purchase twice.
create or replace function public.contact_credits_grant(
  p_team_id uuid, p_user_id uuid, p_credits integer, p_stripe_session_id text,
  p_amount_cents integer default null, p_currency text default null, p_pack_key text default null
) returns integer language plpgsql security definer set search_path to 'public' as $function$
begin
  if p_team_id is null or p_credits is null or p_credits <= 0 then return null; end if;
  insert into public.contact_credit_topups (team_id, user_id, credits, amount_cents, currency, pack_key, stripe_session_id)
  values (p_team_id, p_user_id, p_credits, p_amount_cents, p_currency, p_pack_key, p_stripe_session_id)
  on conflict (stripe_session_id) do nothing;
  return public.contact_credits_topup_balance(p_team_id);
end;
$function$;

-- Monthly allowance FIRST, purchased balance only once it is exhausted. That
-- ordering is what makes a top-up genuinely additive: someone who buys 75 in
-- March and uses 30 of their monthly 50 still has all 75 in April.
create or replace function public.contact_credits_consume_v2(p_team_id uuid, p_monthly_cap integer)
returns table (source text, monthly_used integer, topup_balance integer)
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_month date := date_trunc('month', current_date)::date;
  v_used integer; v_balance integer;
begin
  if p_team_id is null then return query select null::text, 0, 0; return; end if;

  select coalesce(credits_used, 0) into v_used from public.contact_credit_usage
  where team_id = p_team_id and month = v_month;
  v_used := coalesce(v_used, 0);

  if v_used < p_monthly_cap then
    insert into public.contact_credit_usage (month, team_id, credits_used) values (v_month, p_team_id, 1)
    on conflict (month, team_id) do update set credits_used = contact_credit_usage.credits_used + 1, updated_at = now()
    returning credits_used into v_used;
    return query select 'monthly'::text, v_used, public.contact_credits_topup_balance(p_team_id); return;
  end if;

  v_balance := public.contact_credits_topup_balance(p_team_id);
  if v_balance > 0 then
    insert into public.contact_credit_topup_usage (team_id, credits_used) values (p_team_id, 1)
    on conflict (team_id) do update set credits_used = contact_credit_topup_usage.credits_used + 1, updated_at = now();
    return query select 'topup'::text, v_used, public.contact_credits_topup_balance(p_team_id); return;
  end if;

  return query select null::text, v_used, 0;
end;
$function$;

revoke all on function public.contact_credits_grant(uuid, uuid, integer, text, integer, text, text) from public;
revoke all on function public.contact_credits_consume_v2(uuid, integer) from public;
grant execute on function public.contact_credits_grant(uuid, uuid, integer, text, integer, text, text) to service_role;
grant execute on function public.contact_credits_consume_v2(uuid, integer) to service_role;
grant execute on function public.contact_credits_topup_balance(uuid) to service_role, authenticated;
