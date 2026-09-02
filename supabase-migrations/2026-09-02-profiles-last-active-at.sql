-- Powers the "at risk / inactive" member flag and the churn-risk insight
-- on Annie Overview (see netlify/functions/touch-activity.js for how this
-- gets updated, and src/lib/activityPing.js for the throttled frontend
-- call). Until now there was no way to tell "hasn't used the product in
-- 11 days" from "just hasn't needed to" — this column is what makes that
-- distinction real instead of guessed.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS last_active_at timestamptz;

-- Read via its own function rather than folding into
-- get_admin_account_summary — keeps that existing function's return shape
-- untouched for any other caller, and this is a distinct, addable concern.
CREATE OR REPLACE FUNCTION public.get_admin_account_activity()
RETURNS TABLE (user_id uuid, last_active_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN QUERY
  SELECT p.id, p.last_active_at FROM public.profiles p;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_admin_account_activity() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_account_activity() TO authenticated;
ALTER FUNCTION public.get_admin_account_activity() SET search_path = public;
