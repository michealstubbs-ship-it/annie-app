-- Recovered file for schema that has been live in production for a while
-- but was never captured in any checked-in migration — found while setting
-- up a second ("staging") Supabase project as a working schema copy for
-- preview/branch-deploy builds (2026-08-24). Same situation and same fix
-- as 2026-08-23-add-candidate-profile-to-intelligence-signals.sql: this
-- file exists purely so the repo's migration history can actually
-- reconstruct production from an empty database, and does not need to be
-- re-run against the live project (it already has all of this) — but keeps
-- any future fresh environment (staging, disaster recovery, a new
-- engineer) in sync going forward.
--
-- Every statement below was written by reading the ACTUAL definition off
-- production directly (pg_get_functiondef, information_schema.columns,
-- pg_policies, pg_constraint) via the Supabase MCP's execute_sql — not
-- guessed from what the frontend expects. The one exception is that the
-- RLS predicates below are written in their ORIGINAL pre-teams form (plain
-- (select auth.uid()) = user_id, no team_id branch): 2026-08-24-teams-and-
-- shared-crm.sql and 2026-08-24-crm-sharing-model-and-signal-privacy.sql
-- both already ALTER these exact policy names to add the team_id logic —
-- applying this file first and letting those upgrade the predicate
-- afterward reproduces the real chronological history, and lands on
-- exactly the same final state confirmed live on production.
--
-- Five things were missing from the checked-in history:
--
--   1. profiles.is_admin / profiles.linkedin_import_completed — both
--      referenced across several checked-in migrations and components
--      (gates the admin Insights page, the get_error_logs()/
--      get_account_requests()/get_admin_*() RPCs, and the post-signup
--      LinkedIn-import redirect) but never actually created by any
--      migration SQL. 2026-08-21-schema-reference-gap-notes.sql flagged
--      is_admin as a known gap (commented out, "predates this migrations
--      folder") but never linkedin_import_completed, and neither was ever
--      fixed with a real ADD COLUMN.
--
--   2. public.support_messages — backs the admin "Customer insights" /
--      Support tabs (Insights.jsx's Topics/Recent conversations tabs, via
--      get_support_insights()/get_support_conversations() below). Several
--      checked-in migrations already reference this table by name
--      (2026-08-21-performance-rls-and-indexes.sql ALTERs a policy on it,
--      2026-08-22-data-retention.sql adds a cleanup function for it,
--      2026-08-24-chat-rate-limit-retention.sql's sibling table gets the
--      same treatment) but no migration anywhere actually creates it.
--
--   3. get_support_conversations() / get_support_insights() — the two RPCs
--      Insights.jsx's Topics/Recent conversations tabs call. Same
--      SECURITY DEFINER + is_admin-gate + REVOKE/GRANT pattern as every
--      other admin RPC in this schema; copied verbatim off production.
--
--   4. RLS enable + the actual CREATE POLICY for six tables whose table
--      shape 2026-08-21-schema-reference-gap-notes.sql already documented
--      (intelligence_signals, candidates, companies, jobs, meetings,
--      bd_tasks) plus company_enrichment. 2026-08-21-performance-rls-and-
--      indexes.sql ALTERs policies on all of these by name (e.g. ALTER
--      POLICY "bd_tasks_all_own" ...) but until now nothing checked in
--      ever actually created a policy by that name — the ALTER has been
--      silently depending on production having already had it, from
--      before this migrations folder existed.
--
--   5. company_enrichment_select_authenticated — the read policy that lets
--      the frontend read the shared enrichment cache; same
--      never-actually-created situation as #4.

-- ── 1. profiles gap columns ─────────────────────────────────────────────
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_admin boolean DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS linkedin_import_completed boolean DEFAULT false;

-- Same situation, found via a full information_schema diff against
-- production while building the staging copy: contacts.company_id (used
-- once companies exist to link a contact to a company record) and two
-- onboarding columns (writing_style — a sample of the customer's own
-- writing, used to personalize outreach copy; functions — which BD
-- functions/sectors this account covers) were also never added by any
-- checked-in migration.
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES public.companies(id) ON DELETE SET NULL;
ALTER TABLE public.onboarding ADD COLUMN IF NOT EXISTS writing_style text;
ALTER TABLE public.onboarding ADD COLUMN IF NOT EXISTS functions text[] NOT NULL DEFAULT '{}'::text[];

-- ── 2. support_messages ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.support_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  topic text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Own support messages only" ON public.support_messages
  FOR ALL USING ((select auth.uid()) = user_id);

-- ── 3. Admin support-insights RPCs ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_support_conversations()
RETURNS TABLE(user_id uuid, firm_name text, role text, content text, topic text, created_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN QUERY
  SELECT sm.user_id, p.firm_name, sm.role, sm.content, sm.topic, sm.created_at
  FROM public.support_messages sm
  JOIN public.profiles p ON p.id = sm.user_id
  ORDER BY sm.created_at DESC
  LIMIT 200;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_support_conversations() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_support_conversations() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_support_insights()
RETURNS TABLE(topic text, occurrences bigint, last_seen timestamptz, sample_content text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN QUERY
  SELECT
    sm.topic,
    COUNT(*)::bigint AS occurrences,
    MAX(sm.created_at) AS last_seen,
    (ARRAY_AGG(sm.content ORDER BY sm.created_at DESC))[1] AS sample_content
  FROM public.support_messages sm
  WHERE sm.role = 'user' AND sm.topic IS NOT NULL
  GROUP BY sm.topic
  ORDER BY occurrences DESC;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_support_insights() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_support_insights() TO authenticated;

-- ── 4. RLS enable + CREATE POLICY for the gap-notes tables ─────────────
ALTER TABLE public.intelligence_signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "intelligence_signals_select_own" ON public.intelligence_signals
  FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);
CREATE POLICY "intelligence_signals_update_own" ON public.intelligence_signals
  FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

ALTER TABLE public.candidates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "candidates_all_own" ON public.candidates
  FOR ALL TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "companies_all_own" ON public.companies
  FOR ALL TO public
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "jobs_all_own" ON public.jobs
  FOR ALL TO public
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

ALTER TABLE public.meetings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "meetings_all_own" ON public.meetings
  FOR ALL TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

ALTER TABLE public.bd_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bd_tasks_all_own" ON public.bd_tasks
  FOR ALL TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

-- ── 5. company_enrichment read policy ───────────────────────────────────
ALTER TABLE public.company_enrichment ENABLE ROW LEVEL SECURITY;
CREATE POLICY "company_enrichment_select_authenticated" ON public.company_enrichment
  FOR SELECT TO authenticated
  USING (true);
