-- Fix: "column reference "id" is ambiguous" on get_admin_ai_insights and
-- get_admin_escalations, breaking the Overview and Client Escalations tabs
-- in production. Root cause: both functions RETURNS TABLE includes an
-- OUT column literally named `id`, which PL/pgSQL turns into a variable
-- named `id` inside the function body -- so the existing admin-check line
-- `WHERE id = auth.uid()` becomes ambiguous between that variable and
-- public.profiles.id, wherever a RETURNS TABLE happens to have its own
-- `id` column. Every other admin RPC in this file family (get_admin_
-- account_summary, get_admin_funnel, get_admin_metrics_trend,
-- get_admin_escalation_summary) is unaffected because none of THEIR
-- RETURNS TABLE columns are named `id`. Fix: alias public.profiles as p
-- and qualify every reference, same pattern get_admin_funnel already uses.
-- CREATE OR REPLACE is safe here -- same signature, same RETURNS TABLE,
-- body-only change.

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
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true) THEN
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

ALTER FUNCTION public.get_admin_ai_insights(integer) SET search_path = public;

CREATE OR REPLACE FUNCTION public.get_admin_escalations()
RETURNS TABLE (
  id uuid, user_id uuid, firm_name text, customer_email text, category text, excerpt text,
  status text, created_at timestamptz, first_response_at timestamptz, resolved_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = true) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN QUERY
  SELECT e.id, e.user_id, e.firm_name, e.customer_email, e.category, e.excerpt,
         e.status, e.created_at, e.first_response_at, e.resolved_at
  FROM public.support_escalations e
  ORDER BY e.created_at DESC
  LIMIT 200;
END;
$$;

ALTER FUNCTION public.get_admin_escalations() SET search_path = public;
