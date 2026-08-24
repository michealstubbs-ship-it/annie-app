-- Direct product clarification from Michael (2026-08-24): the CRM (companies,
-- contacts, candidates, jobs, deals, meetings, bd_tasks) is meant to be fully
-- shared team-wide, Bullhorn-style — no member should be able to unilaterally
-- pull a record out of the shared pool. Intelligence Feed and Today's Actions
-- are the opposite: they must stay personal to each consultant, since
-- different recruiters on the same team can be working entirely different
-- markets and Annie's prompts have to reflect that. The team owner needs
-- read-only visibility across the whole team's activity on both.
--
-- This migration does three things:
--   1. Locks team_id on every shared-CRM table so only service_role can
--      change it (closes audit finding 3.2 — a member un-sharing a record).
--   2. Removes the latent team-sharing branch from intelligence_signals' and
--      todays_action_state's RLS — both tables already only ever have
--      team_id = NULL in practice (neither write path sets it), so this is
--      not a behavior change today, just closes a real fragility: the
--      moment anything ever populated team_id on these tables, personalized
--      feeds would have silently become team-shared with nothing catching it.
--   3. Adds new, additive, read-only policies letting a team's OWNER see
--      every active member's signals and action state — the "Team admin &
--      insights view" the pricing page already promises but nothing builds
--      yet.

-- ── 1. Lock team_id on the shared-CRM tables ────────────────────────────
-- Same pattern as protect_profiles_is_admin (2026-08-24): silently revert
-- any attempted change to team_id from a non-service_role session, rather
-- than raising, so an unrelated update that happens to echo back the
-- current team_id in its payload isn't rejected outright.
CREATE OR REPLACE FUNCTION public.protect_team_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.team_id IS DISTINCT FROM OLD.team_id AND current_user <> 'service_role' THEN
    NEW.team_id := OLD.team_id;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.protect_team_id() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS protect_team_id_trigger ON public.companies;
CREATE TRIGGER protect_team_id_trigger BEFORE UPDATE ON public.companies FOR EACH ROW EXECUTE FUNCTION public.protect_team_id();

DROP TRIGGER IF EXISTS protect_team_id_trigger ON public.contacts;
CREATE TRIGGER protect_team_id_trigger BEFORE UPDATE ON public.contacts FOR EACH ROW EXECUTE FUNCTION public.protect_team_id();

DROP TRIGGER IF EXISTS protect_team_id_trigger ON public.candidates;
CREATE TRIGGER protect_team_id_trigger BEFORE UPDATE ON public.candidates FOR EACH ROW EXECUTE FUNCTION public.protect_team_id();

DROP TRIGGER IF EXISTS protect_team_id_trigger ON public.jobs;
CREATE TRIGGER protect_team_id_trigger BEFORE UPDATE ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.protect_team_id();

DROP TRIGGER IF EXISTS protect_team_id_trigger ON public.deals;
CREATE TRIGGER protect_team_id_trigger BEFORE UPDATE ON public.deals FOR EACH ROW EXECUTE FUNCTION public.protect_team_id();

DROP TRIGGER IF EXISTS protect_team_id_trigger ON public.meetings;
CREATE TRIGGER protect_team_id_trigger BEFORE UPDATE ON public.meetings FOR EACH ROW EXECUTE FUNCTION public.protect_team_id();

DROP TRIGGER IF EXISTS protect_team_id_trigger ON public.bd_tasks;
CREATE TRIGGER protect_team_id_trigger BEFORE UPDATE ON public.bd_tasks FOR EACH ROW EXECUTE FUNCTION public.protect_team_id();

-- ── 2. intelligence_signals & todays_action_state: personal-only ───────
DROP POLICY IF EXISTS "intelligence_signals_select_own" ON public.intelligence_signals;
CREATE POLICY "intelligence_signals_select_own" ON public.intelligence_signals
  FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "intelligence_signals_update_own" ON public.intelligence_signals;
CREATE POLICY "intelligence_signals_update_own" ON public.intelligence_signals
  FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Own action state only" ON public.todays_action_state;
CREATE POLICY "Own action state only" ON public.todays_action_state
  FOR ALL TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

-- ── 3. Team owner: read-only visibility into members' activity ─────────
-- Additive SELECT policies — Postgres OR's multiple permissive policies for
-- the same command together, so this adds owner visibility without
-- narrowing what the row's own user already sees via the policies above.
CREATE POLICY "Team owners can view members' signals" ON public.intelligence_signals
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.team_members owner_tm
      JOIN public.team_members member_tm ON member_tm.team_id = owner_tm.team_id
      WHERE owner_tm.user_id = (select auth.uid())
        AND owner_tm.role = 'owner'
        AND owner_tm.status = 'active'
        AND member_tm.user_id = intelligence_signals.user_id
        AND member_tm.status = 'active'
    )
  );

CREATE POLICY "Team owners can view members' action state" ON public.todays_action_state
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.team_members owner_tm
      JOIN public.team_members member_tm ON member_tm.team_id = owner_tm.team_id
      WHERE owner_tm.user_id = (select auth.uid())
        AND owner_tm.role = 'owner'
        AND owner_tm.status = 'active'
        AND member_tm.user_id = todays_action_state.user_id
        AND member_tm.status = 'active'
    )
  );
