-- Run this once in the Supabase SQL Editor, same as the other migration
-- files. Depends on 2026-08-26-per-customer-credit-caps.sql already having
-- been run first (it's what creates apollo_usage_platform/
-- theirstack_usage_platform/anthropic_usage_platform, read below) — run
-- that one first if you haven't already.
--
-- Two real gaps found in the "OpEx today" panel added in
-- 2026-08-24-admin-operator-dashboard.sql, both because it was written a
-- day before TheirStack got its own credit cap (2026-08-25) and two days
-- before the per-customer caps migration that split usage tracking into
-- per-user rows plus a dedicated platform-total table (2026-08-26):
--
--  1. get_admin_opex() never looked at theirstack_usage at all — the one
--     dashboard meant to show Michael daily platform spend was silently
--     missing an entire cost line, right as TheirStack became a real,
--     non-trivial part of that spend.
--  2. It summed the (day, user_id)-keyed apollo_usage/anthropic_usage
--     tables to approximate a platform total. That happens to still be
--     arithmetically correct today, since every real reservation writes to
--     both the per-user row and the dedicated *_platform row — but only by
--     coincidence of how apollo_reserve_credits/anthropic_reserve_tokens
--     happens to be implemented right now, and it silently undercounts the
--     rare p_user_id IS NULL system-level call, which only ever posts to
--     the platform table. Reading straight from apollo_usage_platform/
--     theirstack_usage_platform/anthropic_usage_platform — the tables
--     built specifically to answer "what did the whole platform spend
--     today" — is both correct and no longer depends on that coincidence.
--
-- The return shape changes (new theirstack_credits column), and Postgres
-- doesn't allow CREATE OR REPLACE to change a function's declared return
-- type, so this drops and recreates rather than replacing in place.
DROP FUNCTION IF EXISTS public.get_admin_opex(integer);

CREATE FUNCTION public.get_admin_opex(p_days integer DEFAULT 30)
RETURNS TABLE (day date, apollo_credits bigint, theirstack_credits bigint, anthropic_tokens bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN QUERY
  SELECT
    d::date,
    COALESCE((SELECT credits_used FROM public.apollo_usage_platform a WHERE a.day = d::date), 0),
    COALESCE((SELECT credits_used FROM public.theirstack_usage_platform t WHERE t.day = d::date), 0),
    COALESCE((SELECT tokens_used FROM public.anthropic_usage_platform b WHERE b.day = d::date), 0)
  FROM generate_series(current_date - (LEAST(GREATEST(p_days, 1), 365) - 1), current_date, interval '1 day') d
  ORDER BY d;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_admin_opex(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_opex(integer) TO authenticated;
ALTER FUNCTION public.get_admin_opex(integer) SET search_path = public;
