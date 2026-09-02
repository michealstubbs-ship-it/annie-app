-- Historical snapshot for the Annie Overview MRR and signal-quality trend
-- charts. Until now these numbers were only ever computed live — a live
-- query can show "MRR is $3,592 right now" but has nothing to compare
-- against for "compared to 12 weeks ago," even months from now, because
-- nothing was ever saved day by day. This is the fix: one row per day,
-- written by a new scheduled function (admin-daily-metrics-snapshot.js),
-- read back by get_admin_metrics_trend below.
--
-- One row per day (day is the primary key, not just indexed) so the
-- snapshot function can safely upsert if it ever runs twice in one day
-- (a retry, a manual re-trigger) without creating duplicate history.
CREATE TABLE IF NOT EXISTS public.admin_daily_metrics (
  day date PRIMARY KEY,
  mrr numeric NOT NULL,
  active_accounts integer NOT NULL,
  contact_verified_rate numeric,
  company_matched_rate numeric,
  computed_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.admin_daily_metrics ENABLE ROW LEVEL SECURITY;
-- Same posture as support_escalations above: no anon/authenticated
-- policies. The scheduled function writes via the service-role key
-- (bypasses RLS); every read from the app goes through
-- get_admin_metrics_trend below, which does its own is_admin check.

CREATE OR REPLACE FUNCTION public.get_admin_metrics_trend(p_days integer DEFAULT 84)
RETURNS TABLE (day date, mrr numeric, active_accounts integer, contact_verified_rate numeric, company_matched_rate numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN QUERY
  SELECT m.day, m.mrr, m.active_accounts, m.contact_verified_rate, m.company_matched_rate
  FROM public.admin_daily_metrics m
  WHERE m.day >= current_date - LEAST(GREATEST(p_days, 1), 730)
  ORDER BY m.day;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_admin_metrics_trend(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_metrics_trend(integer) TO authenticated;
ALTER FUNCTION public.get_admin_metrics_trend(integer) SET search_path = public;
