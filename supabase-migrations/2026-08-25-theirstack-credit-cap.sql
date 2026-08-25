-- Run this once in the Supabase SQL Editor, same as the other migration files.
--
-- Global daily spend cap for TheirStack API credits (the paid GCC live-job
-- data source added 2026-08-25 — see discoverTheirStackJobs and
-- reserveTheirStackCredits in netlify/functions/lib/scanShared.js). Exact
-- copy of apollo_reserve_credits' design (see
-- 2026-08-21-apollo-credit-cap.sql) for the same reason: without this, a
-- bug, a retried request, or an open endpoint could run up an unbounded
-- bill on a paid third-party API with no ceiling of its own.
--
-- Tune the actual ceiling via the THEIRSTACK_DAILY_CREDIT_CAP Netlify env
-- var (defaults to 40/day if unset — roughly 1,200/month, comfortably
-- under the $49/mo plan's 1,500 monthly credits once upgraded from the
-- free 200-credit trial tier).

CREATE TABLE IF NOT EXISTS theirstack_usage (
  day date PRIMARY KEY,
  credits_used integer NOT NULL DEFAULT 0
);

-- Atomically reserves p_credits against today's usage, same locking
-- behaviour as apollo_reserve_credits — see that function's own comment
-- for why the single INSERT ... ON CONFLICT ... UPDATE is what makes
-- concurrent callers serialize correctly instead of both slipping past the
-- cap.
CREATE OR REPLACE FUNCTION theirstack_reserve_credits(p_credits integer, p_daily_cap integer)
RETURNS boolean AS $$
DECLARE
  v_new_total integer;
BEGIN
  INSERT INTO theirstack_usage (day, credits_used)
  VALUES (CURRENT_DATE, p_credits)
  ON CONFLICT (day) DO UPDATE SET credits_used = theirstack_usage.credits_used + p_credits
  RETURNING credits_used INTO v_new_total;

  IF v_new_total > p_daily_cap THEN
    UPDATE theirstack_usage SET credits_used = credits_used - p_credits WHERE day = CURRENT_DATE;
    RETURN false;
  END IF;

  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER TABLE theirstack_usage ENABLE ROW LEVEL SECURITY;
-- No policies granted on purpose: only the service role (which bypasses
-- RLS entirely) ever reads or writes this table, always from server-side
-- Netlify functions. No customer or anonymous session should be able to
-- see or touch it directly.
