-- Run this once in the Supabase SQL Editor, same as the other migration
-- files.
--
-- 2026-08-26 audit finding: discoverTheirStackJobs (scanShared.js) reserves
-- a flat `limit` (10) TheirStack credits before every call, matching its
-- own comment that TheirStack bills per job RETURNED, not per call -- but
-- never reconciles that reservation down to the number of jobs the API
-- actually returned. A call that matches only 2 jobs (or errors out
-- entirely, matching 0) still permanently counts as 10 credits spent
-- against both the per-customer and platform-wide daily caps -- inflating
-- internal cost tracking relative to what TheirStack actually bills, and
-- able to cap a customer out of live-job discovery earlier than their real
-- spend would justify.
--
-- This adds the release half of the reserve/release pair: after a call
-- returns, scanShared.js now refunds the difference between what was
-- reserved (`limit`) and what TheirStack actually returned (or the whole
-- reservation, if the call failed outright and returned nothing at all).
-- Clamped at zero so a bug can't push a counter negative.
create or replace function public.theirstack_release_credits(
  p_credits integer,
  p_user_id uuid
)
returns void as $$
begin
  if p_credits is null or p_credits <= 0 then
    return;
  end if;

  if p_user_id is not null then
    update public.theirstack_usage
    set credits_used = greatest(0, credits_used - p_credits)
    where day = current_date and user_id = p_user_id;
  end if;

  update public.theirstack_usage_platform
  set credits_used = greatest(0, credits_used - p_credits)
  where day = current_date;
end;
$$ language plpgsql security definer set search_path = public;

-- Server-side only, same lockdown pattern as every reservation RPC.
revoke execute on function public.theirstack_release_credits(integer, uuid) from public, anon, authenticated;
grant execute on function public.theirstack_release_credits(integer, uuid) to service_role;
