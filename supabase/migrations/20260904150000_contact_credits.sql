-- Per-customer monthly contact credits.
--
-- Until now Apollo spend was governed only by DAILY caps applied inside the
-- scan pipeline, and every signal was enriched whether the customer ever
-- looked at it or not. Michael, 2026-09-04: contacts move to on-request, with
-- a real monthly allowance per plan — Starter 50, Growth 150, Team 400 shared.
--
-- Two facts, both verified against the live Apollo API on 2026-09-04, shape
-- this table:
--   * Searching costs nothing (1359 -> 1359 consumed across a real search).
--   * An enrichment that matches nobody costs nothing either
--     (match_confidence "none", 1359 -> 1359).
-- So a credit is consumed ONLY when the customer actually receives a person.
-- A failed lookup is free to Annie and must therefore be free to them — there
-- is no state in which someone pays and gets nothing.
--
-- Keyed on team_id, not user_id, so "Team 400 shared" falls out naturally and
-- a solo account (which still belongs to exactly one team) gets its own pool.

create table if not exists public.contact_credit_usage (
  month date not null,
  team_id uuid not null,
  credits_used integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (month, team_id)
);

alter table public.contact_credit_usage enable row level security;

-- Read-only to the owning team; every write goes through the SECURITY DEFINER
-- function below, so a customer can see their own meter but can never move it.
drop policy if exists contact_credit_usage_select_own_team on public.contact_credit_usage;
create policy contact_credit_usage_select_own_team
  on public.contact_credit_usage for select
  using (
    team_id in (
      select tm.team_id from public.team_members tm
      where tm.user_id = auth.uid() and tm.status = 'active'
    )
  );

-- Consumes exactly one credit, and only ever after a real person has been
-- returned. Returns the new running total for the month so the caller can
-- hand the customer an accurate meter in the same response.
create or replace function public.contact_credits_consume(p_team_id uuid, p_credits integer default 1)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_total integer;
begin
  if p_team_id is null or p_credits is null or p_credits <= 0 then
    return null;
  end if;

  insert into public.contact_credit_usage (month, team_id, credits_used)
  values (date_trunc('month', current_date)::date, p_team_id, p_credits)
  on conflict (month, team_id)
  do update set credits_used = contact_credit_usage.credits_used + p_credits,
                updated_at = now()
  returning credits_used into v_total;

  return v_total;
end;
$function$;

-- Reads the current month's total. Separate from consume so the caller can
-- refuse BEFORE spending anything at Apollo.
create or replace function public.contact_credits_used(p_team_id uuid)
returns integer
language sql
security definer
set search_path to 'public'
as $function$
  select coalesce(
    (select credits_used from public.contact_credit_usage
     where team_id = p_team_id and month = date_trunc('month', current_date)::date),
    0);
$function$;

revoke all on function public.contact_credits_consume(uuid, integer) from public;
grant execute on function public.contact_credits_consume(uuid, integer) to service_role;
grant execute on function public.contact_credits_used(uuid) to service_role, authenticated;
