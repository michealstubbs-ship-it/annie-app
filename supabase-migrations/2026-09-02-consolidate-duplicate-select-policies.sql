-- Consolidates duplicate permissive SELECT policies flagged by the Supabase
-- performance advisor (Postgres evaluates every permissive policy on a
-- query, so two SELECT policies on the same table means the OR-condition
-- gets evaluated twice per row). Effective access is unchanged in both
-- cases -- each pair of policies is merged into one with the same
-- conditions OR'd together.
-- Applied directly to production via Supabase MCP on 2026-09-02.

-- intelligence_signals: merge "Team owners can view members' signals" and
-- "intelligence_signals_select_own" into one SELECT policy.
drop policy if exists "Team owners can view members' signals" on public.intelligence_signals;
drop policy if exists "intelligence_signals_select_own" on public.intelligence_signals;

create policy intelligence_signals_select on public.intelligence_signals
  for select
  to authenticated
  using (
    (select auth.uid()) = user_id
    or exists (
      select 1
      from public.team_members owner_tm
      join public.team_members member_tm on member_tm.team_id = owner_tm.team_id
      where owner_tm.user_id = (select auth.uid())
        and owner_tm.role = 'owner'
        and owner_tm.status = 'active'
        and member_tm.user_id = intelligence_signals.user_id
        and member_tm.status = 'active'
    )
  );

-- todays_action_state: split the old "Own action state only" (FOR ALL) and
-- "Team owners can view members' action state" (SELECT) into 4 policies --
-- one merged SELECT (own row OR team-owner view), and 3 own-row-only
-- policies for insert/update/delete, so a team owner's read access doesn't
-- also imply write access to someone else's action state.
drop policy if exists "Own action state only" on public.todays_action_state;
drop policy if exists "Team owners can view members' action state" on public.todays_action_state;

create policy todays_action_state_select on public.todays_action_state
  for select
  to authenticated
  using (
    (select auth.uid()) = user_id
    or exists (
      select 1
      from public.team_members owner_tm
      join public.team_members member_tm on member_tm.team_id = owner_tm.team_id
      where owner_tm.user_id = (select auth.uid())
        and owner_tm.role = 'owner'
        and owner_tm.status = 'active'
        and member_tm.user_id = todays_action_state.user_id
        and member_tm.status = 'active'
    )
  );

create policy todays_action_state_insert on public.todays_action_state
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy todays_action_state_update on public.todays_action_state
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy todays_action_state_delete on public.todays_action_state
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);
