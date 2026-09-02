-- Real persistence for support escalations. Until now, support-escalate.js
-- (see its own header) only ever sent Michael a live email — there was no
-- database row, no status, no timestamps, so the "Client Escalations" tab
-- on the Annie Overview mock had nothing real to read from. This migration
-- is the fix: the email keeps going out exactly as before (Michael still
-- wants to know immediately, not only when he opens a dashboard), and now
-- a row is ALSO written so the dashboard can show real open/in-progress/
-- resolved counts and real time-to-first-response, not invented ones.
--
-- Same access-control pattern as every other admin RPC in this file family
-- (get_admin_account_summary etc., 2026-08-24): SECURITY DEFINER, an
-- explicit is_admin check that RAISE EXCEPTIONs for anyone else, REVOKE
-- from PUBLIC/anon, GRANT to authenticated only. No new access-control
-- mechanism.
CREATE TABLE IF NOT EXISTS public.support_escalations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.profiles(id),
  firm_name text,
  customer_email text,
  category text,
  excerpt text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  first_response_at timestamptz,
  resolved_at timestamptz
);

ALTER TABLE public.support_escalations ENABLE ROW LEVEL SECURITY;
-- No policies for anon/authenticated on purpose — the insert from
-- support-escalate.js goes through the service-role key (bypasses RLS, same
-- as every other server-side write in this codebase), and every read/write
-- from the app goes through the SECURITY DEFINER functions below, which do
-- their own is_admin check rather than relying on row-level policy.

CREATE INDEX IF NOT EXISTS support_escalations_status_idx ON public.support_escalations (status);
CREATE INDEX IF NOT EXISTS support_escalations_created_at_idx ON public.support_escalations (created_at DESC);

-- List + summary in one call, same "everything the tab needs, fetched
-- together" shape as loadAdminOverview's other RPCs.
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
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true) THEN
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

REVOKE EXECUTE ON FUNCTION public.get_admin_escalations() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_escalations() TO authenticated;
ALTER FUNCTION public.get_admin_escalations() SET search_path = public;

-- Summary counts + avg time-to-first-response, computed in SQL once rather
-- than the frontend re-deriving it from the full row list (which will get
-- long once escalations pile up over months).
CREATE OR REPLACE FUNCTION public.get_admin_escalation_summary()
RETURNS TABLE (
  open_count bigint, in_progress_count bigint, resolved_30d_count bigint,
  avg_first_response_hours numeric
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
    (SELECT count(*) FROM public.support_escalations WHERE status = 'open'),
    (SELECT count(*) FROM public.support_escalations WHERE status = 'in_progress'),
    (SELECT count(*) FROM public.support_escalations WHERE status = 'resolved' AND resolved_at > now() - interval '30 days'),
    (SELECT round(avg(EXTRACT(EPOCH FROM (first_response_at - created_at)) / 3600.0)::numeric, 1)
       FROM public.support_escalations WHERE first_response_at IS NOT NULL);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_admin_escalation_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_escalation_summary() TO authenticated;
ALTER FUNCTION public.get_admin_escalation_summary() SET search_path = public;

-- One deliberate action per status change (never silently inferred), so
-- "first response" and "resolved" always reflect a real human action, not
-- a guess. Moving to 'in_progress' the first time stamps first_response_at
-- if it isn't already set (a later move back to 'in_progress' — say from a
-- reopened case — never clobbers the original first-response time). Moving
-- to 'resolved' stamps resolved_at every time, since a case can be
-- reopened and resolved again.
CREATE OR REPLACE FUNCTION public.admin_update_escalation_status(p_id uuid, p_status text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_status NOT IN ('open', 'in_progress', 'resolved') THEN
    RAISE EXCEPTION 'Invalid status: %', p_status;
  END IF;

  UPDATE public.support_escalations
  SET status = p_status,
      first_response_at = CASE WHEN p_status = 'in_progress' AND first_response_at IS NULL THEN now() ELSE first_response_at END,
      resolved_at = CASE WHEN p_status = 'resolved' THEN now() ELSE resolved_at END
  WHERE id = p_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_update_escalation_status(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_escalation_status(uuid, text) TO authenticated;
ALTER FUNCTION public.admin_update_escalation_status(uuid, text) SET search_path = public;
