-- Backs the new "Overview" tab on the admin Insights page (built 2026-08-24
-- at Michael's request for a real operator dashboard: MRR, accounts by
-- tier, growth, a signup funnel, at-risk accounts, team seat activation,
-- data quality, and platform OpEx). Every function here follows the exact
-- pattern already established by get_support_insights / get_error_logs /
-- get_account_requests (2026-08-21): SECURITY DEFINER, an explicit
-- is_admin check that RAISE EXCEPTIONs for anyone else, REVOKE from
-- PUBLIC/anon, GRANT to authenticated only. No new access-control
-- mechanism, just more functions using the one that already exists.
--
-- Deliberately does NOT compute dollar amounts in SQL — tier pricing lives
-- in one place (src/lib/pricing.js, shared with Billing.jsx) so a price
-- change never has to be made twice. These functions return raw
-- tier/status/seats rows and let the frontend do the arithmetic against
-- that single source of truth.

-- One row per subscription, joined with the firm name and team it belongs
-- to. RLS on subscriptions is per-user; this is the one place a cross-
-- account admin view is allowed, the same way get_account_requests already
-- crosses account_requests' own per-user RLS.
CREATE OR REPLACE FUNCTION public.get_admin_account_summary()
RETURNS TABLE (
  user_id uuid, firm_name text, email text, team_id uuid, team_name text,
  tier text, status text, billing_interval text, seats integer,
  cancel_at_period_end boolean, current_period_end timestamptz, subscription_created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN QUERY
  SELECT s.user_id, p.firm_name, p.email, s.team_id, t.name, s.tier, s.status, s.billing_interval, s.seats,
         s.cancel_at_period_end, s.current_period_end, s.created_at
  FROM public.subscriptions s
  JOIN public.profiles p ON p.id = s.user_id
  LEFT JOIN public.teams t ON t.id = s.team_id
  ORDER BY s.created_at DESC;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_admin_account_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_account_summary() TO authenticated;
ALTER FUNCTION public.get_admin_account_summary() SET search_path = public;

-- Signup → onboarding → import → first scan → first action → paid. Each
-- stage picks the most honest existing signal rather than adding new
-- tracking: "first scan run" is onboarding.initial_scan_triggered_at (set
-- the moment a scan is actually kicked off, not just requested), "first
-- action taken" is a row existing in signal_outcomes at all (logged
-- passively — see src/lib/signalOutcomes.js's own header — every time a
-- recruiter acts on a signal, nothing invented for this dashboard).
CREATE OR REPLACE FUNCTION public.get_admin_funnel()
RETURNS TABLE (
  total_signups bigint, onboarding_completed bigint, linkedin_imported bigint,
  first_scan_run bigint, first_action_taken bigint, converted_to_paid bigint
)
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
    (SELECT count(*) FROM public.profiles),
    (SELECT count(*) FROM public.profiles WHERE onboarding_completed = true),
    (SELECT count(*) FROM public.profiles WHERE linkedin_import_completed = true),
    (SELECT count(DISTINCT user_id) FROM public.onboarding WHERE initial_scan_triggered_at IS NOT NULL),
    (SELECT count(DISTINCT user_id) FROM public.signal_outcomes),
    (SELECT count(DISTINCT user_id) FROM public.subscriptions WHERE status IN ('active', 'trialing'));
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_admin_funnel() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_funnel() TO authenticated;
ALTER FUNCTION public.get_admin_funnel() SET search_path = public;

-- Daily new-account count over a trailing window, for the growth chart.
CREATE OR REPLACE FUNCTION public.get_admin_signup_trend(p_days integer DEFAULT 30)
RETURNS TABLE (day date, signups bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN QUERY
  SELECT d::date, count(p.id)
  FROM generate_series(current_date - (LEAST(GREATEST(p_days, 1), 365) - 1), current_date, interval '1 day') d
  LEFT JOIN public.profiles p ON p.created_at::date = d::date
  GROUP BY d
  ORDER BY d;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_admin_signup_trend(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_signup_trend(integer) TO authenticated;
ALTER FUNCTION public.get_admin_signup_trend(integer) SET search_path = public;

-- Per-team seat activation (invited vs. actually active), for the "Team
-- seat activation" panel — a stalled team rollout is invisible in
-- aggregate MRR, this makes it visible per team.
CREATE OR REPLACE FUNCTION public.get_admin_team_seats()
RETURNS TABLE (team_id uuid, team_name text, total_members bigint, active_members bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN QUERY
  SELECT tm.team_id, t.name, count(*), count(*) FILTER (WHERE tm.status = 'active')
  FROM public.team_members tm
  JOIN public.teams t ON t.id = tm.team_id
  GROUP BY tm.team_id, t.name
  ORDER BY t.name;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_admin_team_seats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_team_seats() TO authenticated;
ALTER FUNCTION public.get_admin_team_seats() SET search_path = public;

-- A proxy for whether the product is actually working, separate from
-- revenue: how much of what Annie surfaces is actually verified/enriched,
-- and how many signals are just sitting there stale (found, never acted
-- on, 30+ days old) — the closest read on match quality the current
-- schema supports without adding a new confidence field.
CREATE OR REPLACE FUNCTION public.get_admin_data_quality()
RETURNS TABLE (
  signals_total bigint, signals_contact_verified bigint,
  companies_total bigint, companies_matched bigint,
  signals_stale bigint
)
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
    (SELECT count(*) FROM public.intelligence_signals),
    (SELECT count(*) FROM public.intelligence_signals WHERE contact_verified = true),
    (SELECT count(*) FROM public.company_enrichment),
    (SELECT count(*) FROM public.company_enrichment WHERE matched = true),
    (SELECT count(*) FROM public.intelligence_signals WHERE status = 'new' AND found_at < now() - interval '30 days');
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_admin_data_quality() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_data_quality() TO authenticated;
ALTER FUNCTION public.get_admin_data_quality() SET search_path = public;

-- 24h vs prior-24h error counts, for the platform-health status pill. Top
-- error sources/messages reuse the existing get_error_logs(limit, source)
-- rather than a second function duplicating that read.
CREATE OR REPLACE FUNCTION public.get_admin_error_health()
RETURNS TABLE (last_24h bigint, prior_24h bigint)
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
    count(*) FILTER (WHERE created_at > now() - interval '24 hours'),
    count(*) FILTER (WHERE created_at > now() - interval '48 hours' AND created_at <= now() - interval '24 hours')
  FROM public.error_logs;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_admin_error_health() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_error_health() TO authenticated;
ALTER FUNCTION public.get_admin_error_health() SET search_path = public;

-- Daily Apollo credit / Anthropic token spend over a trailing window, for
-- the OpEx panel. apollo_usage/anthropic_usage are platform-wide daily
-- counters (see 2026-08-2x cost-tracking migrations), not per-user, so
-- they carry their own RLS an ordinary customer can't read across days —
-- this is the admin-gated read path for them, same pattern as every
-- function above.
CREATE OR REPLACE FUNCTION public.get_admin_opex(p_days integer DEFAULT 30)
RETURNS TABLE (day date, apollo_credits bigint, anthropic_tokens bigint)
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
    COALESCE((SELECT sum(credits_used) FROM public.apollo_usage a WHERE a.day = d::date), 0),
    COALESCE((SELECT sum(tokens_used) FROM public.anthropic_usage b WHERE b.day = d::date), 0)
  FROM generate_series(current_date - (LEAST(GREATEST(p_days, 1), 365) - 1), current_date, interval '1 day') d
  ORDER BY d;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_admin_opex(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_opex(integer) TO authenticated;
ALTER FUNCTION public.get_admin_opex(integer) SET search_path = public;
