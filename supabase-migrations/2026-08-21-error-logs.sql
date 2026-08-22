-- Applied live to the annie app project via direct database connection —
-- kept here for the record, same as every other migration in this folder.
--
-- Adds real error visibility. Until now, a broken scan or a failed signup
-- only ever showed up in the browser console or Netlify's own function
-- logs — both places nobody was actually watching, so the only way to find
-- out something broke in production was a customer saying so. This gives
-- client and server code one shared place to write errors to, and gives an
-- admin (matching the same is_admin check already used by
-- get_support_conversations/get_support_insights) a way to actually see
-- them from inside the app, on the existing Insights page.

CREATE TABLE IF NOT EXISTS public.error_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (source IN ('client', 'function')),
  fn_name text,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  message text NOT NULL,
  stack text,
  context jsonb,
  url text,
  user_agent text
);

CREATE INDEX IF NOT EXISTS error_logs_created_at_idx ON public.error_logs (created_at DESC);

ALTER TABLE public.error_logs ENABLE ROW LEVEL SECURITY;

-- Write-only from the client's own session (or anon, since a failed signup
-- or a login error happens before there's a user to attach). No SELECT/
-- UPDATE/DELETE policy exists at all — same "enabled, no policy" shape the
-- performance advisor already saw and accepted on apollo_usage, which
-- blocks direct reads for everyone except service_role (server-side
-- functions) and the SECURITY DEFINER function below.
CREATE POLICY "Anyone can log an error" ON public.error_logs
  FOR INSERT TO anon, authenticated
  WITH CHECK (true);

-- Same admin-gate pattern as get_support_conversations/get_support_insights:
-- RAISE EXCEPTION for anyone whose own profile isn't is_admin, no separate
-- role system to keep in sync.
CREATE OR REPLACE FUNCTION public.get_error_logs(p_limit integer DEFAULT 200, p_source text DEFAULT NULL)
RETURNS TABLE (
  id uuid, created_at timestamptz, source text, fn_name text,
  user_id uuid, message text, stack text, context jsonb, url text, user_agent text
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
  SELECT el.id, el.created_at, el.source, el.fn_name, el.user_id, el.message, el.stack, el.context, el.url, el.user_agent
  FROM public.error_logs el
  WHERE p_source IS NULL OR el.source = p_source
  ORDER BY el.created_at DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 500);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_error_logs(integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_error_logs(integer, text) TO authenticated;
ALTER FUNCTION public.get_error_logs(integer, text) SET search_path = public;
