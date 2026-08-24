-- Correction to get_admin_account_summary (same migration pass,
-- 2026-08-24): the churn-count logic on the frontend needs when a
-- subscription's status last changed, not just when the subscription row
-- was first created — a subscription created a year ago and canceled
-- yesterday must count as recent churn, which created_at alone can't tell.
-- stripe-webhook.js sets updated_at on every status change including
-- cancellation, so that's the right column. DROP+CREATE because adding an
-- OUT column to an existing RETURNS TABLE function isn't a valid REPLACE.
DROP FUNCTION IF EXISTS public.get_admin_account_summary();

CREATE FUNCTION public.get_admin_account_summary()
RETURNS TABLE (
  user_id uuid, firm_name text, email text, team_id uuid, team_name text,
  tier text, status text, billing_interval text, seats integer,
  cancel_at_period_end boolean, current_period_end timestamptz,
  subscription_created_at timestamptz, subscription_updated_at timestamptz
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
         s.cancel_at_period_end, s.current_period_end, s.created_at, s.updated_at
  FROM public.subscriptions s
  JOIN public.profiles p ON p.id = s.user_id
  LEFT JOIN public.teams t ON t.id = s.team_id
  ORDER BY s.created_at DESC;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_admin_account_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_account_summary() TO authenticated;
ALTER FUNCTION public.get_admin_account_summary() SET search_path = public;
