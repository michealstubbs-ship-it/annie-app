-- Applied live to the annie app project via direct database connection —
-- kept here for the record, same as every other migration in this folder.
--
-- Two pieces from the pre-launch audit's remaining list:
--
-- 1. Blocker #5: 8 of 9 signal types had zero independent verification —
-- the AI's own word was the entire product. This doesn't (can't, cheaply)
-- verify the CLAIM in a signal is true, but it does verify the one thing
-- that's cheap and meaningful: that sourceUrl is a real, live page and not
-- a hallucinated or malformed link. netlify/functions/lib/scanShared.js's
-- new verifySourceUrl() sets this before a row is ever written.
ALTER TABLE public.intelligence_signals ADD COLUMN IF NOT EXISTS source_verified boolean NOT NULL DEFAULT false;

-- 2. Low/polish: no GDPR-style export/delete flow, and the audit noted even
-- the manual "email support" fallback process didn't exist yet either. This
-- gives customers a real, in-app way to file the request and gives an admin
-- (same is_admin pattern as every other admin-only table in this app) a
-- place to see and action them, without requiring a transactional email
-- provider to exist first.
CREATE TABLE IF NOT EXISTS public.account_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  request_type text NOT NULL CHECK (request_type IN ('export', 'delete')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
  note text
);

CREATE INDEX IF NOT EXISTS account_requests_created_at_idx ON public.account_requests (created_at DESC);

ALTER TABLE public.account_requests ENABLE ROW LEVEL SECURITY;

-- A customer can file a request and see their own past requests (so
-- Settings can show "Request submitted, pending"), never anyone else's.
CREATE POLICY "Own account requests only" ON public.account_requests
  FOR ALL TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

-- Same admin-gate pattern as get_support_conversations/get_support_insights/
-- get_error_logs: RAISE EXCEPTION for anyone whose own profile isn't
-- is_admin. Lets an admin see every customer's request, which the row-level
-- policy above deliberately doesn't allow directly.
CREATE OR REPLACE FUNCTION public.get_account_requests()
RETURNS TABLE (id uuid, created_at timestamptz, email text, request_type text, status text, note text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN QUERY
  SELECT ar.id, ar.created_at, ar.email, ar.request_type, ar.status, ar.note
  FROM public.account_requests ar
  ORDER BY ar.created_at DESC
  LIMIT 500;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_account_requests() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_account_requests() TO authenticated;
ALTER FUNCTION public.get_account_requests() SET search_path = public;
