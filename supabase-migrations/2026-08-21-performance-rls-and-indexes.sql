-- Applied live to the annie app project via direct database connection —
-- kept here for the record, same as every other migration in this folder.
--
-- Two performance-advisor findings, fixed together since they came from the
-- same review pass. Neither matters yet at today's tiny row counts, both
-- would matter as real customer data grows — cheap to fix now, expensive to
-- diagnose as a mystery slowdown later.

-- 1. Every RLS policy called auth.uid() directly, which Postgres
-- re-evaluates for EVERY row scanned. Wrapping it as (select auth.uid())
-- lets Postgres evaluate it once per query and reuse the result. No
-- behavior change, same access rules — just how the check is evaluated.
ALTER POLICY "Own cache only" ON public.actions_cache
  USING ((select auth.uid()) = user_id);
ALTER POLICY "bd_tasks_all_own" ON public.bd_tasks
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);
ALTER POLICY "candidates_all_own" ON public.candidates
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);
ALTER POLICY "Own chat only" ON public.chat_messages
  USING ((select auth.uid()) = user_id);
ALTER POLICY "companies_all_own" ON public.companies
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);
ALTER POLICY "Own contacts only" ON public.contacts
  USING ((select auth.uid()) = user_id);
ALTER POLICY "Own deals only" ON public.deals
  USING ((select auth.uid()) = user_id);
ALTER POLICY "intelligence_signals_select_own" ON public.intelligence_signals
  USING ((select auth.uid()) = user_id);
ALTER POLICY "intelligence_signals_update_own" ON public.intelligence_signals
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);
ALTER POLICY "jobs_all_own" ON public.jobs
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);
ALTER POLICY "meetings_all_own" ON public.meetings
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);
ALTER POLICY "Own onboarding only" ON public.onboarding
  USING ((select auth.uid()) = user_id);
ALTER POLICY "Own profile only" ON public.profiles
  USING ((select auth.uid()) = id);
ALTER POLICY "Own signals only" ON public.signals
  USING ((select auth.uid()) = user_id);
ALTER POLICY "Own support messages only" ON public.support_messages
  USING ((select auth.uid()) = user_id);

-- 2. Foreign key columns with no covering index — every one of these is a
-- column the app filters or joins on directly (a customer's own
-- contacts/deals/meetings/tasks, a signal's linked contact).
CREATE INDEX IF NOT EXISTS bd_tasks_candidate_id_idx ON public.bd_tasks (candidate_id);
CREATE INDEX IF NOT EXISTS bd_tasks_contact_id_idx ON public.bd_tasks (contact_id);
CREATE INDEX IF NOT EXISTS chat_messages_user_id_idx ON public.chat_messages (user_id);
CREATE INDEX IF NOT EXISTS contacts_user_id_idx ON public.contacts (user_id);
CREATE INDEX IF NOT EXISTS deals_contact_id_idx ON public.deals (contact_id);
CREATE INDEX IF NOT EXISTS deals_user_id_idx ON public.deals (user_id);
CREATE INDEX IF NOT EXISTS intelligence_signals_linked_contact_id_idx ON public.intelligence_signals (linked_contact_id);
CREATE INDEX IF NOT EXISTS meetings_candidate_id_idx ON public.meetings (candidate_id);
CREATE INDEX IF NOT EXISTS meetings_contact_id_idx ON public.meetings (contact_id);
CREATE INDEX IF NOT EXISTS signals_contact_id_idx ON public.signals (contact_id);
CREATE INDEX IF NOT EXISTS signals_user_id_idx ON public.signals (user_id);
CREATE INDEX IF NOT EXISTS support_messages_user_id_idx ON public.support_messages (user_id);
