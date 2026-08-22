-- Two unrelated cleanups from the same full-stack scale-readiness audit
-- (2026-08-22), batched into one migration since both are small.
--
-- 1. Drops public.signals — the pre-intelligence_signals table. Confirmed
-- 0 rows live and confirmed no code references it except the dead, unrouted
-- src/components/Signals.jsx, removed in the same commit as this migration.
-- Everything moved to intelligence_signals a while ago; this was just never
-- cleaned up.
--
-- 2. Shards apollo_usage's daily spend-cap row by hour instead of by day.
-- Every Apollo-credit-spending call across EVERY customer previously took
-- Postgres's row lock on one single row per day (see
-- 2026-08-21-apollo-credit-cap.sql) — fine at low volume, but a deliberate
-- global serialization point as customer count grows. Same cap semantics
-- (still summed across the whole day when checking against p_daily_cap),
-- now spread across 24 rows instead of 1.
--
-- Applied directly to the live DB via the Supabase MCP on 2026-08-22 (named
-- `drop_dead_signals_table_and_shard_apollo_usage`). Run this once in the
-- Supabase SQL Editor if setting up a fresh environment.

drop table if exists public.signals cascade;

alter table public.apollo_usage add column if not exists hour smallint;
update public.apollo_usage set hour = 0 where hour is null;
alter table public.apollo_usage alter column hour set not null;
alter table public.apollo_usage alter column hour set default 0;
alter table public.apollo_usage drop constraint if exists apollo_usage_pkey;
alter table public.apollo_usage add primary key (day, hour);

create or replace function public.apollo_reserve_credits(p_credits integer, p_daily_cap integer)
returns boolean as $$
declare
  v_hour integer := extract(hour from now());
  v_day_total integer;
begin
  insert into apollo_usage (day, hour, credits_used)
  values (current_date, v_hour, p_credits)
  on conflict (day, hour) do update set credits_used = apollo_usage.credits_used + p_credits;

  select coalesce(sum(credits_used), 0) into v_day_total from apollo_usage where day = current_date;

  if v_day_total > p_daily_cap then
    update apollo_usage set credits_used = credits_used - p_credits where day = current_date and hour = v_hour;
    return false;
  end if;

  return true;
end;
$$ language plpgsql security definer;

alter function public.apollo_reserve_credits(integer, integer) set search_path = public;
revoke execute on function public.apollo_reserve_credits(integer, integer) from public, anon, authenticated;
grant execute on function public.apollo_reserve_credits(integer, integer) to service_role;
