-- Drops the old, platform-only 2-argument overloads of
-- apollo_reserve_credits/theirstack_reserve_credits/anthropic_reserve_tokens,
-- superseded by the 4-argument per-customer versions added in
-- 2026-08-26-per-customer-credit-caps.sql. Confirmed via grep that no call
-- site anywhere in the codebase still invokes the 2-arg signature (every
-- real reserve*Credits/reserveAnthropicTokens call in scanShared.js/
-- aiUsage.js passes p_user_id/p_user_daily_cap/p_platform_daily_cap) —
-- these were dead code, not a live path.
--
-- Worth dropping rather than leaving alone: the old versions compute their
-- day-total via a separate SELECT after the INSERT (`select sum(...) into
-- v_day_total from apollo_usage where day = current_date`), not the
-- INSERT...ON CONFLICT...RETURNING pattern the 4-arg versions use. That's a
-- genuine TOCTOU race under concurrency — two callers could each insert
-- their own row, then each independently SELECT a total that doesn't yet
-- reflect the other's still-uncommitted insert, and both pass a cap check
-- that combined they'd already have failed. Already confirmed EXECUTE is
-- revoked from anon/authenticated on every one of these (service_role
-- only), so this was never externally exploitable — but dead code with a
-- real race condition baked in is still worth removing outright rather than
-- leaving as a landmine for a future call site that accidentally matches
-- the old 2-key argument shape instead of the current 4-key one.
drop function if exists public.apollo_reserve_credits(integer, integer);
drop function if exists public.theirstack_reserve_credits(integer, integer);
drop function if exists public.anthropic_reserve_tokens(integer, integer);
