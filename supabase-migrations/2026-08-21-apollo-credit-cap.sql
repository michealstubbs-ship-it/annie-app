-- Run this once in the Supabase SQL Editor, same as the other migration files.
--
-- Global daily spend cap for Apollo.io API credits. Every server-side call
-- that spends an Apollo credit (LinkedIn-import company enrichment, the
-- onboarding scan's hot-company/contact/company lookups, the recurring
-- cron's same lookups) now reserves against this table first, via the
-- reserveApolloCredits() helper in netlify/functions/lib/scanShared.js.
-- Without this, a bug, a retried request, or an open endpoint could run up
-- an unbounded bill on a paid third-party API with no ceiling of its own —
-- this is the safety net, not a replacement for keeping the real API key
-- private.
--
-- Tune the actual ceiling via the APOLLO_DAILY_CREDIT_CAP Netlify env var
-- (defaults to 500/day if unset) — set it to whatever your real Apollo plan
-- can sustain.

CREATE TABLE IF NOT EXISTS apollo_usage (
  day date PRIMARY KEY,
  credits_used integer NOT NULL DEFAULT 0
);

-- Atomically reserves p_credits against today's usage. Returns true and
-- commits the reservation if the new total stays within p_daily_cap,
-- otherwise rolls the reservation back and returns false. The single
-- INSERT ... ON CONFLICT ... UPDATE takes Postgres's normal row lock on
-- today's row for the duration of the statement, so concurrent callers
-- (parallel sector-group scans, two customers' scans running at once, a
-- LinkedIn import happening at the same time) serialize correctly instead
-- of both reading a stale total and both slipping past the cap.
CREATE OR REPLACE FUNCTION apollo_reserve_credits(p_credits integer, p_daily_cap integer)
RETURNS boolean AS $$
DECLARE
  v_new_total integer;
BEGIN
  INSERT INTO apollo_usage (day, credits_used)
  VALUES (CURRENT_DATE, p_credits)
  ON CONFLICT (day) DO UPDATE SET credits_used = apollo_usage.credits_used + p_credits
  RETURNING credits_used INTO v_new_total;

  IF v_new_total > p_daily_cap THEN
    UPDATE apollo_usage SET credits_used = credits_used - p_credits WHERE day = CURRENT_DATE;
    RETURN false;
  END IF;

  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER TABLE apollo_usage ENABLE ROW LEVEL SECURITY;
-- No policies granted on purpose: only the service role (which bypasses
-- RLS entirely) ever reads or writes this table, always from server-side
-- Netlify functions. No customer or anonymous session should be able to
-- see or touch it directly.
