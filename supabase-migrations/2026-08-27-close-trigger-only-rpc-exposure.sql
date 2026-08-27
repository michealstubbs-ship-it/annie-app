-- 2026-08-27, Michael: "What else should we look at?" — found via
-- get_advisors(security) on production, not something anyone had asked
-- about: PostgREST auto-exposes every function in the public schema as a
-- callable RPC endpoint (POST /rest/v1/rpc/<name>) the moment it's created,
-- regardless of whether it was ever meant to be called that way. Postgres
-- itself also auto-grants EXECUTE to PUBLIC on every new function unless
-- explicitly revoked — the same oversight this codebase has already caught
-- and fixed for its admin RPCs (see the REVOKE/GRANT pattern in
-- 2026-08-27-learned-sources-quality-guard.sql and elsewhere), just missed
-- here because these five were never written with a direct caller in mind
-- at all.
--
-- Four of these (learn_company_for_sectors, learn_from_customer_company,
-- learn_from_customer_candidate, record_signal_pool_outcome) are SECURITY
-- DEFINER and have ZERO legitimate direct callers anywhere in this
-- codebase (confirmed via grep across src/ and netlify/functions/ — every
-- reference is a code comment, never a .rpc(...) call) — they exist purely
-- to be invoked by their own AFTER INSERT triggers on companies/
-- candidates/signal_outcomes. Left as default-granted, this meant any
-- fully unauthenticated visitor could currently call, for example:
--   POST /rest/v1/rpc/learn_company_for_sectors
--   { "p_user_id": "<any uuid>", "p_company": "Whatever Corp", ... }
-- and — if that uuid happens to belong to a real onboarding row — write
-- directly into the SHARED annie_learned_sources table (the exact table
-- this whole session's "Annie always learning" thread has spent so much
-- effort keeping clean and shared-safe), completely bypassing RLS via
-- SECURITY DEFINER, no login required. Revoking EXECUTE here doesn't
-- touch how these functions actually run in normal use: Postgres invokes a
-- trigger function directly as part of statement execution, which is not
-- an EXECUTE-privilege-checked call path — only a genuine direct RPC call
-- (or another function explicitly calling it) is. The one internal caller
-- each of these has (its own trigger wrapper, or record_signal_pool_outcome
-- being invoked by ITS trigger) runs as the function owner throughout
-- (SECURITY DEFINER), which always retains implicit EXECUTE on its own
-- objects — nothing here is being revoked from the owner.
revoke execute on function public.learn_company_for_sectors(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.learn_from_customer_company() from public, anon, authenticated;
revoke execute on function public.learn_from_customer_candidate() from public, anon, authenticated;
revoke execute on function public.record_signal_pool_outcome() from public, anon, authenticated;

-- my_active_team_ids() is different from the four above: it's genuinely
-- needed by `authenticated`, not unused — team_members' own live RLS
-- policy ("Members can view their team roster") calls it directly
-- (`using (team_id in (select my_active_team_ids()))`), evaluated as the
-- querying authenticated user. So only anon's grant is removed here;
-- authenticated is revoked-then-explicitly-re-granted (revoking PUBLIC
-- also removes what authenticated inherited through it) so real customers
-- browsing their team roster see no change at all.
revoke execute on function public.my_active_team_ids() from public, anon;
grant execute on function public.my_active_team_ids() to authenticated;

-- Separately, three other SECURITY DEFINER functions (the daily-cap
-- credit/token reservation functions — genuinely called from Netlify
-- functions under the service role, so no RPC-exposure issue here) were
-- missing `SET search_path`, unlike every other SECURITY DEFINER function
-- in this schema. A mutable search_path on a SECURITY DEFINER function is
-- its own, separate hardening gap (flagged WARN, not the same issue as the
-- REVOKEs above): without a pinned search_path, name resolution inside the
-- function body follows whatever search_path is active in the CALLING
-- session, which an attacker able to create objects can manipulate to
-- shadow a referenced table. These three are re-created below with the
-- exact same bodies, only `set search_path = public` added — no behaviour
-- change for any legitimate caller.
create or replace function public.anthropic_reserve_tokens(p_tokens integer, p_user_id uuid, p_user_daily_cap integer, p_platform_daily_cap integer)
returns text
language plpgsql
security definer
set search_path = public
as $$
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
$$;

create or replace function public.apollo_reserve_credits(p_credits integer, p_user_id uuid, p_user_daily_cap integer, p_platform_daily_cap integer)
returns text
language plpgsql
security definer
set search_path = public
as $$
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
$$;

create or replace function public.theirstack_reserve_credits(p_credits integer, p_user_id uuid, p_user_daily_cap integer, p_platform_daily_cap integer)
returns text
language plpgsql
security definer
set search_path = public
as $$
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
$$;
