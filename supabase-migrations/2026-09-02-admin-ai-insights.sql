-- "Annie's Read" — a daily-generated feed of grounded observations on
-- Annie's Overview dashboard, narrate-only by design: Annie reads the real
-- numbers (admin_daily_metrics history, escalation counts, account
-- activity) and writes short, cited observations for Michael to act on
-- himself. It never takes an action on its own — every row starts 'new'
-- and stays that way until a human explicitly approves or dismisses it
-- (admin_review_insight below). This is deliberate: an AI that quietly
-- acts on its own read of noisy business data is a much bigger risk than
-- one that's occasionally wrong in a card Michael can just dismiss.
--
-- Same access-control pattern as every other admin RPC in this file family
-- (get_admin_account_summary etc., 2026-08-24): SECURITY DEFINER, an
-- explicit is_admin check, REVOKE from PUBLIC/anon, GRANT to authenticated.
CREATE TABLE IF NOT EXISTS public.admin_ai_insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  generated_at date NOT NULL DEFAULT current_date,
  category text NOT NULL CHECK (category IN ('finance', 'product', 'customer', 'growth')),
  severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'watch', 'action')),
  headline text NOT NULL,
  detail text NOT NULL,
  cited_metric text,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'approved', 'dismissed')),
  reviewed_by uuid REFERENCES public.profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.admin_ai_insights ENABLE ROW LEVEL SECURITY;
-- No anon/authenticated policies, same reasoning as support_escalations:
-- the daily generator writes via the service-role key, every read/review
-- from the app goes through the SECURITY DEFINER functions below.

CREATE INDEX IF NOT EXISTS admin_ai_insights_generated_at_idx ON public.admin_ai_insights (generated_at DESC);
CREATE INDEX IF NOT EXISTS admin_ai_insights_status_idx ON public.admin_ai_insights (status);

CREATE OR REPLACE FUNCTION public.get_admin_ai_insights(p_days integer DEFAULT 30)
RETURNS TABLE (
  id uuid, generated_at date, category text, severity text, headline text, detail text,
  cited_metric text, status text, reviewed_at timestamptz, created_at timestamptz
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
  SELECT i.id, i.generated_at, i.category, i.severity, i.headline, i.detail,
         i.cited_metric, i.status, i.reviewed_at, i.created_at
  FROM public.admin_ai_insights i
  WHERE i.generated_at >= current_date - LEAST(GREATEST(p_days, 1), 365)
  ORDER BY i.generated_at DESC, i.created_at DESC
  LIMIT 200;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_admin_ai_insights(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_ai_insights(integer) TO authenticated;
ALTER FUNCTION public.get_admin_ai_insights(integer) SET search_path = public;

-- One deliberate human action per insight — 'approved' means "yes, I'm
-- acting on this," 'dismissed' means "noted, not doing anything about it."
-- Never inferred, never automatic.
CREATE OR REPLACE FUNCTION public.admin_review_insight(p_id uuid, p_status text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_status NOT IN ('approved', 'dismissed') THEN
    RAISE EXCEPTION 'Invalid status: %', p_status;
  END IF;

  UPDATE public.admin_ai_insights
  SET status = p_status, reviewed_by = auth.uid(), reviewed_at = now()
  WHERE id = p_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_review_insight(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_review_insight(uuid, text) TO authenticated;
ALTER FUNCTION public.admin_review_insight(uuid, text) SET search_path = public;
