-- Run this once in the Supabase SQL Editor, same as the other migration files.
--
-- 2026-08-26, Michael: the Apollo/TheirStack daily caps added in
-- 2026-08-21/2026-08-25, and the Anthropic daily token cap added in
-- 2026-08-22, were ALL entirely PLATFORM-WIDE — one shared counter for
-- every customer combined. That meant one customer's own scan could
-- exhaust the whole day's budget (a single onboarding scan's discovery
-- phase alone can spend the entire old 40/day TheirStack default, or a
-- couple of Growth-tier scans can approach the old 2,000,000/day Anthropic
-- cap on their own) and every OTHER customer's scan that day got starved —
-- fewer/no contacts, fewer/no live-job leads, or scan calls silently
-- refused outright — with zero visible reason why. This replaces all
-- three single shared counters with a PER-CUSTOMER daily cap as the
-- primary protection — no customer can touch another's budget — while
-- keeping a platform-wide total as a secondary backstop purely for
-- Michael's own real-plan cost ceiling (both checked atomically in the
-- same reservation, both roll back together if either is exceeded).
--
-- Per-customer and platform cap VALUES are resolved in application code —
-- see resolveResourceCaps() in netlify/functions/lib/entitlements.js —
-- not hardcoded here, so they can differ by the calling customer's tier
-- (Starter/Growth/Team) without a migration change every time a number is
-- tuned.
--
-- The reserve functions now RETURN TEXT ('ok' | 'user_cap' | 'platform_cap')
-- instead of a bare boolean — a per-customer cap hit is normal, expected,
-- affects nobody else, and doesn't deserve a page; a platform-wide cap hit
-- affects EVERY customer's scan that day and does. The old boolean
-- couldn't tell these apart, so the Slack alerting built on top of it
-- (alertCapHitOnce in scanShared.js) would either alert on a routine
-- per-customer cap (noisy, wrong) or say nothing about a real platform-
-- wide problem. Callers should now treat anything other than 'ok' as "not
-- reserved" (same as the old `false`), same as before.
--
-- Old tables (apollo_usage/theirstack_usage, day-only primary key) are
-- dropped and recreated with a user-scoped shape — these were always just
-- a same-day rolling counter, not data worth preserving across the schema
-- change; today's partial platform-wide count resets to zero as a side
-- effect, which only ever gives today more headroom, never less. Same for
-- anthropic_usage (day+hour primary key, summed across all hours to get a
-- day total) — recreated user-scoped, day+hour dropped since sharding by
-- hour was only ever about write-lock contention, and Postgres's row-level
-- locking on a (day, user_id) key already spreads that load across
-- customers without needing an hour dimension too.

DROP TABLE IF EXISTS apollo_usage;
CREATE TABLE apollo_usage (
  day date NOT NULL,
  user_id uuid, -- nullable: a system-level call with no customer context in scope (should be rare after this change) is tracked toward the platform total only, never blocked on a per-user check it can't meaningfully apply to.
  credits_used integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id)
);

DROP TABLE IF EXISTS apollo_usage_platform;
CREATE TABLE apollo_usage_platform (
  day date PRIMARY KEY,
  credits_used integer NOT NULL DEFAULT 0
);

-- Reserves p_credits against BOTH this customer's own daily total (capped
-- at p_user_daily_cap) and the platform-wide total (capped at
-- p_platform_daily_cap) in one transaction — if either would be exceeded,
-- BOTH reservations roll back and this returns the specific reason, so a
-- customer who's still under their own cap can still be paused by the
-- platform-wide backstop, and vice versa, without ever leaving the two
-- counters out of sync with each other. The user check runs first: when
-- both caps would be exceeded by the same call, the response should say
-- "your own cap", not "the platform cap", since that's the one the caller
-- can actually reason about (nothing they can do about the platform one).
CREATE OR REPLACE FUNCTION apollo_reserve_credits(p_credits integer, p_user_id uuid, p_user_daily_cap integer, p_platform_daily_cap integer)
RETURNS text AS $$
DECLARE
  v_user_total integer := 0;
  v_platform_total integer;
BEGIN
  IF p_user_id IS NOT NULL THEN
    INSERT INTO apollo_usage (day, user_id, credits_used)
    VALUES (CURRENT_DATE, p_user_id, p_credits)
    ON CONFLICT (day, user_id) DO UPDATE SET credits_used = apollo_usage.credits_used + p_credits
    RETURNING credits_used INTO v_user_total;
  END IF;

  INSERT INTO apollo_usage_platform (day, credits_used)
  VALUES (CURRENT_DATE, p_credits)
  ON CONFLICT (day) DO UPDATE SET credits_used = apollo_usage_platform.credits_used + p_credits
  RETURNING credits_used INTO v_platform_total;

  IF p_user_id IS NOT NULL AND v_user_total > p_user_daily_cap THEN
    UPDATE apollo_usage SET credits_used = credits_used - p_credits WHERE day = CURRENT_DATE AND user_id = p_user_id;
    UPDATE apollo_usage_platform SET credits_used = credits_used - p_credits WHERE day = CURRENT_DATE;
    RETURN 'user_cap';
  END IF;

  IF v_platform_total > p_platform_daily_cap THEN
    IF p_user_id IS NOT NULL THEN
      UPDATE apollo_usage SET credits_used = credits_used - p_credits WHERE day = CURRENT_DATE AND user_id = p_user_id;
    END IF;
    UPDATE apollo_usage_platform SET credits_used = credits_used - p_credits WHERE day = CURRENT_DATE;
    RETURN 'platform_cap';
  END IF;

  RETURN 'ok';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER TABLE apollo_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE apollo_usage_platform ENABLE ROW LEVEL SECURITY;
-- No policies granted on purpose, same as before: only the service role
-- (which bypasses RLS entirely) ever reads or writes these tables, always
-- from server-side Netlify functions.

-- Exact same shape and reasoning, for TheirStack.
DROP TABLE IF EXISTS theirstack_usage;
CREATE TABLE theirstack_usage (
  day date NOT NULL,
  user_id uuid,
  credits_used integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id)
);

DROP TABLE IF EXISTS theirstack_usage_platform;
CREATE TABLE theirstack_usage_platform (
  day date PRIMARY KEY,
  credits_used integer NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION theirstack_reserve_credits(p_credits integer, p_user_id uuid, p_user_daily_cap integer, p_platform_daily_cap integer)
RETURNS text AS $$
DECLARE
  v_user_total integer := 0;
  v_platform_total integer;
BEGIN
  IF p_user_id IS NOT NULL THEN
    INSERT INTO theirstack_usage (day, user_id, credits_used)
    VALUES (CURRENT_DATE, p_user_id, p_credits)
    ON CONFLICT (day, user_id) DO UPDATE SET credits_used = theirstack_usage.credits_used + p_credits
    RETURNING credits_used INTO v_user_total;
  END IF;

  INSERT INTO theirstack_usage_platform (day, credits_used)
  VALUES (CURRENT_DATE, p_credits)
  ON CONFLICT (day) DO UPDATE SET credits_used = theirstack_usage_platform.credits_used + p_credits
  RETURNING credits_used INTO v_platform_total;

  IF p_user_id IS NOT NULL AND v_user_total > p_user_daily_cap THEN
    UPDATE theirstack_usage SET credits_used = credits_used - p_credits WHERE day = CURRENT_DATE AND user_id = p_user_id;
    UPDATE theirstack_usage_platform SET credits_used = credits_used - p_credits WHERE day = CURRENT_DATE;
    RETURN 'user_cap';
  END IF;

  IF v_platform_total > p_platform_daily_cap THEN
    IF p_user_id IS NOT NULL THEN
      UPDATE theirstack_usage SET credits_used = credits_used - p_credits WHERE day = CURRENT_DATE AND user_id = p_user_id;
    END IF;
    UPDATE theirstack_usage_platform SET credits_used = credits_used - p_credits WHERE day = CURRENT_DATE;
    RETURN 'platform_cap';
  END IF;

  RETURN 'ok';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER TABLE theirstack_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE theirstack_usage_platform ENABLE ROW LEVEL SECURITY;

-- Same shape and reasoning again, for Anthropic tokens — this is the
-- newly-discovered second real instance of the exact bug Michael flagged
-- (found by reading netlify/functions/lib/aiUsage.js and the 2026-08-22
-- migration this replaces): anthropic_reserve_tokens summed tokens_used
-- across every hour of the day — i.e. across every customer and every
-- call site combined — with no per-customer scoping at all, so one
-- customer's scan could exhaust the day's whole Anthropic budget and every
-- other customer's chat message or scheduled scan that day would get
-- silently refused with "Anthropic daily token cap reached", for a reason
-- that had nothing to do with them.
DROP TABLE IF EXISTS anthropic_usage;
CREATE TABLE anthropic_usage (
  day date NOT NULL,
  user_id uuid,
  tokens_used integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id)
);

DROP TABLE IF EXISTS anthropic_usage_platform;
CREATE TABLE anthropic_usage_platform (
  day date PRIMARY KEY,
  tokens_used integer NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION anthropic_reserve_tokens(p_tokens integer, p_user_id uuid, p_user_daily_cap integer, p_platform_daily_cap integer)
RETURNS text AS $$
DECLARE
  v_user_total integer := 0;
  v_platform_total integer;
BEGIN
  IF p_user_id IS NOT NULL THEN
    INSERT INTO anthropic_usage (day, user_id, tokens_used)
    VALUES (CURRENT_DATE, p_user_id, p_tokens)
    ON CONFLICT (day, user_id) DO UPDATE SET tokens_used = anthropic_usage.tokens_used + p_tokens
    RETURNING tokens_used INTO v_user_total;
  END IF;

  INSERT INTO anthropic_usage_platform (day, tokens_used)
  VALUES (CURRENT_DATE, p_tokens)
  ON CONFLICT (day) DO UPDATE SET tokens_used = anthropic_usage_platform.tokens_used + p_tokens
  RETURNING tokens_used INTO v_platform_total;

  IF p_user_id IS NOT NULL AND v_user_total > p_user_daily_cap THEN
    UPDATE anthropic_usage SET tokens_used = tokens_used - p_tokens WHERE day = CURRENT_DATE AND user_id = p_user_id;
    UPDATE anthropic_usage_platform SET tokens_used = tokens_used - p_tokens WHERE day = CURRENT_DATE;
    RETURN 'user_cap';
  END IF;

  IF v_platform_total > p_platform_daily_cap THEN
    IF p_user_id IS NOT NULL THEN
      UPDATE anthropic_usage SET tokens_used = tokens_used - p_tokens WHERE day = CURRENT_DATE AND user_id = p_user_id;
    END IF;
    UPDATE anthropic_usage_platform SET tokens_used = tokens_used - p_tokens WHERE day = CURRENT_DATE;
    RETURN 'platform_cap';
  END IF;

  RETURN 'ok';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER TABLE anthropic_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE anthropic_usage_platform ENABLE ROW LEVEL SECURITY;

-- chat_rate_limit (per-user, per-minute call-frequency cap) is untouched —
-- it was already correctly keyed on (user_id, minute_bucket), checked
-- directly against the 2026-08-22 migration before writing this file. Not
-- a shared-resource bug, no change needed.
