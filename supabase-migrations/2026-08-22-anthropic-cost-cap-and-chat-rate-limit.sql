-- Anthropic spend had no cap anywhere in this codebase — Apollo already had
-- one (apollo_reserve_credits, 2026-08-21-apollo-credit-cap.sql). This
-- mirrors that exact pattern for Anthropic, sharded by hour from the start
-- (learning from apollo_usage's own single-row-per-day bottleneck found in
-- the same 2026-08-22 audit that surfaced this gap), tunable via the
-- ANTHROPIC_DAILY_TOKEN_CAP env var. Wired into chat.js, intelligence-scan.js,
-- and scan-now-background.js — every Anthropic call site in the codebase.
--
-- Also adds a separate, per-user-per-minute call-frequency cap
-- (chat_reserve_call) for chat.js specifically — a distinct concern from
-- the cost cap: even within the per-call token ceiling already enforced in
-- chat.js, a single valid session could otherwise call it in a tight loop
-- indefinitely. Tunable via CHAT_PER_MINUTE_CAP.
--
-- Applied directly to the live DB via the Supabase MCP on 2026-08-22 (named
-- `anthropic_cost_cap_and_chat_rate_limit`). Run this once in the Supabase
-- SQL Editor if setting up a fresh environment.

create table if not exists public.anthropic_usage (
  day date not null,
  hour smallint not null,
  tokens_used integer not null default 0,
  primary key (day, hour)
);
alter table public.anthropic_usage enable row level security;

create or replace function public.anthropic_reserve_tokens(p_tokens integer, p_daily_cap integer)
returns boolean as $$
declare
  v_hour integer := extract(hour from now());
  v_day_total integer;
begin
  insert into anthropic_usage (day, hour, tokens_used)
  values (current_date, v_hour, p_tokens)
  on conflict (day, hour) do update set tokens_used = anthropic_usage.tokens_used + p_tokens;

  select coalesce(sum(tokens_used), 0) into v_day_total from anthropic_usage where day = current_date;

  if v_day_total > p_daily_cap then
    update anthropic_usage set tokens_used = tokens_used - p_tokens where day = current_date and hour = v_hour;
    return false;
  end if;

  return true;
end;
$$ language plpgsql security definer;

alter function public.anthropic_reserve_tokens(integer, integer) set search_path = public;
revoke execute on function public.anthropic_reserve_tokens(integer, integer) from public, anon, authenticated;
grant execute on function public.anthropic_reserve_tokens(integer, integer) to service_role;

create table if not exists public.chat_rate_limit (
  user_id uuid not null,
  minute_bucket timestamptz not null,
  call_count integer not null default 0,
  primary key (user_id, minute_bucket)
);
alter table public.chat_rate_limit enable row level security;

create or replace function public.chat_reserve_call(p_user_id uuid, p_per_minute_cap integer)
returns boolean as $$
declare
  v_bucket timestamptz := date_trunc('minute', now());
  v_count integer;
begin
  insert into chat_rate_limit (user_id, minute_bucket, call_count)
  values (p_user_id, v_bucket, 1)
  on conflict (user_id, minute_bucket) do update set call_count = chat_rate_limit.call_count + 1
  returning call_count into v_count;

  return v_count <= p_per_minute_cap;
end;
$$ language plpgsql security definer;

alter function public.chat_reserve_call(uuid, integer) set search_path = public;
revoke execute on function public.chat_reserve_call(uuid, integer) from public, anon, authenticated;
grant execute on function public.chat_reserve_call(uuid, integer) to service_role;
