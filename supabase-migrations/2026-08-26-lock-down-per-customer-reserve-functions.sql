-- Already applied live to the production project via direct database
-- connection during the 2026-08-26 line-by-line audit — kept here for the
-- record, same as every other migration in this folder.
--
-- Found during that audit: the 2026-08-26 per-customer-credit-caps
-- migration created 4-arg overloads of apollo_reserve_credits,
-- theirstack_reserve_credits, and anthropic_reserve_tokens (all SECURITY
-- DEFINER) with NO REVOKE/GRANT lockdown at all — Postgres grants EXECUTE
-- to PUBLIC by default on function creation, so all three were callable
-- directly by anon/authenticated via /rest/v1/rpc/... This is the exact
-- bug class 2026-08-21-lock-down-security-definer-functions.sql already
-- fixed once for the old 2-arg apollo_reserve_credits — that fix just
-- didn't cover the new 4-arg overloads added five days later, and
-- theirstack_reserve_credits (both its 2-arg AND 4-arg forms) was never
-- locked down at all in the first place, since it was added on
-- 2026-08-25 without the same treatment.
--
-- Verified live BEFORE this fix: anon and authenticated could both
-- execute apollo_reserve_credits(4-arg), anthropic_reserve_tokens(4-arg),
-- and theirstack_reserve_credits (both 2-arg and 4-arg) directly — any
-- logged-in customer (or, for TheirStack, even a logged-out visitor)
-- could call these with an arbitrary p_credits/p_tokens and an arbitrary
-- p_user_daily_cap/p_platform_daily_cap of their own choosing, completely
-- bypassing the real caps this migration was built to enforce, and could
-- also pass any other customer's p_user_id to burn through that specific
-- customer's own per-customer budget. Verified AFTER this fix: all six
-- signatures now show anon/authenticated EXECUTE = false, service_role =
-- true, matching the intended "server-side only" design.
REVOKE EXECUTE ON FUNCTION public.apollo_reserve_credits(integer, uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apollo_reserve_credits(integer, uuid, integer, integer) TO service_role;

REVOKE EXECUTE ON FUNCTION public.theirstack_reserve_credits(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.theirstack_reserve_credits(integer, integer) TO service_role;

REVOKE EXECUTE ON FUNCTION public.theirstack_reserve_credits(integer, uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.theirstack_reserve_credits(integer, uuid, integer, integer) TO service_role;

REVOKE EXECUTE ON FUNCTION public.anthropic_reserve_tokens(integer, uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anthropic_reserve_tokens(integer, uuid, integer, integer) TO service_role;
