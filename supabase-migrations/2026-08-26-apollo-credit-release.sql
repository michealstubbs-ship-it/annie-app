-- Run this once in the Supabase SQL Editor, same as the other migration
-- files.
--
-- 4th-pass audit finding (2026-08-26): every Apollo call site
-- (discoverHotCompanies, enrichCompany, verifyContact/lookupContact/
-- lookupContactByName in scanShared.js, apollo-enrich-companies.js,
-- resolve-signal-contact.js) reserves credits via reserveApolloCredits
-- before making the call, but nothing ever released that reservation on
-- failure -- unlike TheirStack, which got exactly this fix
-- (theirstack-credit-release.sql) the same day. A timeout, a 429, a 500, an
-- expired/rotated API key, or a malformed response body all still
-- permanently cost credits against both the per-customer and platform-wide
-- daily caps, exactly as if the call had succeeded -- so a real Apollo
-- outage burns through the platform-wide daily cap FASTER than normal
-- operation would, throttling every other customer's genuine usage that
-- day on top of the outage itself.
--
-- This is the release half of the reserve/release pair, mirroring
-- theirstack_release_credits exactly: scanShared.js's new
-- releaseApolloCredits() calls this whenever a reserved Apollo call fails
-- outright (thrown error or a non-ok response), refunding the full
-- reservation since -- unlike TheirStack's per-job billing -- every real
-- Apollo call site here reserves a flat, fixed number of credits per call,
-- not a variable "up to N" ceiling, so there's no partial-success case to
-- reconcile, only "it worked, keep the reservation" or "it didn't, give it
-- back." Clamped at zero so a bug can't push a counter negative.
create or replace function public.apollo_release_credits(
  p_credits integer,
  p_user_id uuid
)
returns void as $$
begin
  if p_credits is null or p_credits <= 0 then
    return;
  end if;

  if p_user_id is not null then
    update public.apollo_usage
    set credits_used = greatest(0, credits_used - p_credits)
    where day = current_date and user_id = p_user_id;
  end if;

  update public.apollo_usage_platform
  set credits_used = greatest(0, credits_used - p_credits)
  where day = current_date;
end;
$$ language plpgsql security definer set search_path = public;

-- Server-side only, same lockdown pattern as every reservation RPC.
revoke execute on function public.apollo_release_credits(integer, uuid) from public, anon, authenticated;
grant execute on function public.apollo_release_credits(integer, uuid) to service_role;
