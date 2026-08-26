-- Run this once in the Supabase SQL Editor, same as the other migration
-- files.
--
-- 2026-08-26: start-trial-checkout.js's `?code=annie100` free-month link had
-- no limit on it at all -- no expiry, no per-use cap, no rate limiting, and
-- (by design, so a bare marketing-site <a href> works with zero JS) no
-- Turnstile check either. The code's own comment reasoned "the only way
-- anyone gets this link is Michael handing it out directly, so sending it
-- IS the approval step" -- true the first time, but fragile: it's a plain
-- GET link with the code visible in the URL itself, and the moment it's
-- shared anywhere public (a screenshot, a forum post, a forwarded email) it
-- can mint unlimited free 30-day trials with no card on file. Trialing
-- accounts aren't a lesser tier internally (LIVE_STATUSES treats them the
-- same as active), so each one spends real Apollo/Anthropic/TheirStack
-- credit for up to 30 days with zero revenue behind it.
--
-- This adds the one column needed to count real redemptions and enforce a
-- cap -- see start-trial-checkout.js and stripe-webhook.js for the
-- enforcement itself. Additive and nullable: every existing subscription
-- row simply has this as null (not a free-month signup), no backfill
-- needed.
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS free_month_code text;

-- Backs the redemption-count check in start-trial-checkout.js (a
-- `count(*) WHERE free_month_code = 'annie100'` on every free-month
-- checkout attempt) -- partial index since almost every row will be null.
CREATE INDEX IF NOT EXISTS idx_subscriptions_free_month_code
  ON public.subscriptions (free_month_code)
  WHERE free_month_code IS NOT NULL;
