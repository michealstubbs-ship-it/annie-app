-- Multi-tenant foundation for the Starter/Growth/Team pricing rebuild.
-- Confirmed with Michael (2026-08-24): every account is a "team" from day
-- one, even a solo Starter/Growth signup (a team of one) -- so there's
-- exactly one code path for tier lookups and CRM-sharing, and upgrading to
-- Team later is just inviting more people into a team that already exists,
-- never a data migration event. Team's CRM sharing is "fully shared": every
-- active member of a team sees and can edit the same contacts/deals/
-- candidates/etc, not a per-seat private copy.
--
-- Purely additive. Nothing existing is dropped, renamed, or has its column
-- types changed. Existing policies are altered in place (same policy name,
-- new predicate) rather than dropped-and-recreated, so there's no window
-- where a table has zero policies on it.
--
-- Applied directly to the live DB via the Supabase MCP on 2026-08-24 (named
-- `teams_and_shared_crm`). Run this once in the Supabase SQL Editor if
-- setting up a fresh environment.

-- ---------------------------------------------------------------------
-- 1. Core tables
-- ---------------------------------------------------------------------

create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'My Team',
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.teams enable row level security;

create table if not exists public.team_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  -- Null user_id + a set invited_email is a pending invite (see
  -- team-invite.js); handle_new_user() below activates it the moment that
  -- email completes signup, matched case-insensitively.
  user_id uuid references auth.users(id) on delete cascade,
  invited_email text,
  role text not null default 'member' check (role in ('owner', 'member')),
  status text not null default 'invited' check (status in ('invited', 'active')),
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  constraint team_members_identity check (user_id is not null or invited_email is not null)
);
alter table public.team_members enable row level security;

-- A user can only ever be an active member of one team in this model (kept
-- simple deliberately -- "which team am I on" always has exactly one
-- answer, no team-switcher UI needed anywhere in the app).
create unique index if not exists team_members_active_user_uidx on public.team_members(user_id) where status = 'active';
create unique index if not exists team_members_team_email_uidx on public.team_members(team_id, lower(invited_email)) where invited_email is not null and user_id is null;
create index if not exists team_members_user_id_idx on public.team_members(user_id);
create index if not exists team_members_team_id_idx on public.team_members(team_id);

-- Read-only for authenticated users -- every write (team creation, invite,
-- accept, removal) goes through service-role Netlify functions that
-- enforce the actual business rules (owner-only invites, seat caps) RLS
-- alone can't express well. Same pattern already used for `subscriptions`
-- ("Own subscription read-only" -- writes only via the service-role
-- webhook).
create policy "Members can view their team" on public.teams
  for select using (
    id in (select team_id from public.team_members where user_id = (select auth.uid()) and status = 'active')
  );

create policy "Members can view their team roster" on public.team_members
  for select using (
    team_id in (select team_id from public.team_members tm2 where tm2.user_id = (select auth.uid()) and tm2.status = 'active')
  );

-- ---------------------------------------------------------------------
-- 2. Additive team_id column across every team-scoped table
-- ---------------------------------------------------------------------

alter table public.contacts add column if not exists team_id uuid references public.teams(id);
alter table public.deals add column if not exists team_id uuid references public.teams(id);
alter table public.candidates add column if not exists team_id uuid references public.teams(id);
alter table public.meetings add column if not exists team_id uuid references public.teams(id);
alter table public.intelligence_signals add column if not exists team_id uuid references public.teams(id);
alter table public.todays_action_state add column if not exists team_id uuid references public.teams(id);
alter table public.bd_tasks add column if not exists team_id uuid references public.teams(id);
alter table public.jobs add column if not exists team_id uuid references public.teams(id);
alter table public.companies add column if not exists team_id uuid references public.teams(id);
alter table public.subscriptions add column if not exists team_id uuid references public.teams(id);

create unique index if not exists subscriptions_team_id_uidx on public.subscriptions(team_id) where team_id is not null;
create index if not exists contacts_team_id_idx on public.contacts(team_id);
create index if not exists deals_team_id_idx on public.deals(team_id);
create index if not exists candidates_team_id_idx on public.candidates(team_id);
create index if not exists meetings_team_id_idx on public.meetings(team_id);
create index if not exists intelligence_signals_team_id_idx on public.intelligence_signals(team_id);
create index if not exists todays_action_state_team_id_idx on public.todays_action_state(team_id);
create index if not exists bd_tasks_team_id_idx on public.bd_tasks(team_id);
create index if not exists jobs_team_id_idx on public.jobs(team_id);
create index if not exists companies_team_id_idx on public.companies(team_id);

-- ---------------------------------------------------------------------
-- 3. Auto-fill team_id on insert -- zero application code has to change
-- ---------------------------------------------------------------------
-- Every insert into these tables already sets user_id (that's how RLS
-- currently scopes them). Rather than touching every insert call site
-- across the frontend, the scan functions, and onboarding to also pass
-- team_id, one BEFORE INSERT trigger resolves it from the inserting user's
-- active team membership. Runs before RLS's WITH CHECK is evaluated, so the
-- new team-based policy below sees the filled-in value, not NULL.

create or replace function public.fill_team_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.team_id is null and new.user_id is not null then
    select team_id into new.team_id
    from public.team_members
    where user_id = new.user_id and status = 'active'
    limit 1;
  end if;
  return new;
end;
$$;
revoke execute on function public.fill_team_id() from public, anon, authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['contacts','deals','candidates','meetings','intelligence_signals','todays_action_state','bd_tasks','jobs','companies']
  loop
    execute format('drop trigger if exists trg_fill_team_id on public.%I', t);
    execute format('create trigger trg_fill_team_id before insert on public.%I for each row execute function public.fill_team_id()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 4. handle_new_user(): bootstrap a personal team, or complete a pending
--    invite if this signup's email matches one.
-- ---------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $function$
declare
  v_pending_membership_id uuid;
  v_team_id uuid;
begin
  insert into public.profiles (id, email, full_name, firm_name)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data->>'full_name',
    new.raw_user_meta_data->>'firm_name'
  );

  select id, team_id into v_pending_membership_id, v_team_id
  from public.team_members
  where status = 'invited' and user_id is null and lower(invited_email) = lower(new.email)
  order by created_at asc
  limit 1;

  if v_pending_membership_id is not null then
    update public.team_members
    set user_id = new.id, status = 'active', activated_at = now()
    where id = v_pending_membership_id;
  else
    insert into public.teams (name, created_by) values ('My Team', new.id) returning id into v_team_id;
    insert into public.team_members (team_id, user_id, role, status, activated_at)
    values (v_team_id, new.id, 'owner', 'active', now());
  end if;

  return new;
end;
$function$;

-- ---------------------------------------------------------------------
-- 5. Backfill every existing user (today: just Michael) with a personal
--    team, and stamp team_id onto their existing rows.
-- ---------------------------------------------------------------------

do $$
declare
  r record;
  v_team_id uuid;
begin
  for r in select id from auth.users loop
    if not exists (select 1 from public.team_members where user_id = r.id) then
      insert into public.teams (name, created_by) values ('My Team', r.id) returning id into v_team_id;
      insert into public.team_members (team_id, user_id, role, status, activated_at)
      values (v_team_id, r.id, 'owner', 'active', now());

      update public.contacts set team_id = v_team_id where user_id = r.id and team_id is null;
      update public.deals set team_id = v_team_id where user_id = r.id and team_id is null;
      update public.candidates set team_id = v_team_id where user_id = r.id and team_id is null;
      update public.meetings set team_id = v_team_id where user_id = r.id and team_id is null;
      update public.intelligence_signals set team_id = v_team_id where user_id = r.id and team_id is null;
      update public.todays_action_state set team_id = v_team_id where user_id = r.id and team_id is null;
      update public.bd_tasks set team_id = v_team_id where user_id = r.id and team_id is null;
      update public.jobs set team_id = v_team_id where user_id = r.id and team_id is null;
      update public.companies set team_id = v_team_id where user_id = r.id and team_id is null;
      update public.subscriptions set team_id = v_team_id where user_id = r.id and team_id is null;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 6. Cut RLS over from "owned by this user" to "owned by this team",
--    with a defensive fallback to the original per-user check for any row
--    team_id somehow never got filled on. After the backfill above, that
--    fallback should never actually fire for existing data -- it exists
--    purely so a gap here fails closed (visible only to the original
--    owner, exactly today's behavior) rather than open.
-- ---------------------------------------------------------------------

alter policy "Own contacts only" on public.contacts
  using (
    (team_id is not null and team_id in (select team_id from public.team_members where user_id = (select auth.uid()) and status = 'active'))
    or (team_id is null and (select auth.uid()) = user_id)
  )
  with check (
    (team_id is not null and team_id in (select team_id from public.team_members where user_id = (select auth.uid()) and status = 'active'))
    or (team_id is null and (select auth.uid()) = user_id)
  );

alter policy "Own deals only" on public.deals
  using (
    (team_id is not null and team_id in (select team_id from public.team_members where user_id = (select auth.uid()) and status = 'active'))
    or (team_id is null and (select auth.uid()) = user_id)
  )
  with check (
    (team_id is not null and team_id in (select team_id from public.team_members where user_id = (select auth.uid()) and status = 'active'))
    or (team_id is null and (select auth.uid()) = user_id)
  );

alter policy "candidates_all_own" on public.candidates
  using (
    (team_id is not null and team_id in (select team_id from public.team_members where user_id = (select auth.uid()) and status = 'active'))
    or (team_id is null and (select auth.uid()) = user_id)
  )
  with check (
    (team_id is not null and team_id in (select team_id from public.team_members where user_id = (select auth.uid()) and status = 'active'))
    or (team_id is null and (select auth.uid()) = user_id)
  );

alter policy "meetings_all_own" on public.meetings
  using (
    (team_id is not null and team_id in (select team_id from public.team_members where user_id = (select auth.uid()) and status = 'active'))
    or (team_id is null and (select auth.uid()) = user_id)
  )
  with check (
    (team_id is not null and team_id in (select team_id from public.team_members where user_id = (select auth.uid()) and status = 'active'))
    or (team_id is null and (select auth.uid()) = user_id)
  );

alter policy "bd_tasks_all_own" on public.bd_tasks
  using (
    (team_id is not null and team_id in (select team_id from public.team_members where user_id = (select auth.uid()) and status = 'active'))
    or (team_id is null and (select auth.uid()) = user_id)
  )
  with check (
    (team_id is not null and team_id in (select team_id from public.team_members where user_id = (select auth.uid()) and status = 'active'))
    or (team_id is null and (select auth.uid()) = user_id)
  );

alter policy "jobs_all_own" on public.jobs
  using (
    (team_id is not null and team_id in (select team_id from public.team_members where user_id = (select auth.uid()) and status = 'active'))
    or (team_id is null and (select auth.uid()) = user_id)
  )
  with check (
    (team_id is not null and team_id in (select team_id from public.team_members where user_id = (select auth.uid()) and status = 'active'))
    or (team_id is null and (select auth.uid()) = user_id)
  );

alter policy "companies_all_own" on public.companies
  using (
    (team_id is not null and team_id in (select team_id from public.team_members where user_id = (select auth.uid()) and status = 'active'))
    or (team_id is null and (select auth.uid()) = user_id)
  )
  with check (
    (team_id is not null and team_id in (select team_id from public.team_members where user_id = (select auth.uid()) and status = 'active'))
    or (team_id is null and (select auth.uid()) = user_id)
  );

alter policy "Own action state only" on public.todays_action_state
  using (
    (team_id is not null and team_id in (select team_id from public.team_members where user_id = (select auth.uid()) and status = 'active'))
    or (team_id is null and (select auth.uid()) = user_id)
  )
  with check (
    (team_id is not null and team_id in (select team_id from public.team_members where user_id = (select auth.uid()) and status = 'active'))
    or (team_id is null and (select auth.uid()) = user_id)
  );

alter policy "intelligence_signals_select_own" on public.intelligence_signals
  using (
    (team_id is not null and team_id in (select team_id from public.team_members where user_id = (select auth.uid()) and status = 'active'))
    or (team_id is null and (select auth.uid()) = user_id)
  );

alter policy "intelligence_signals_update_own" on public.intelligence_signals
  using (
    (team_id is not null and team_id in (select team_id from public.team_members where user_id = (select auth.uid()) and status = 'active'))
    or (team_id is null and (select auth.uid()) = user_id)
  )
  with check (
    (team_id is not null and team_id in (select team_id from public.team_members where user_id = (select auth.uid()) and status = 'active'))
    or (team_id is null and (select auth.uid()) = user_id)
  );

-- Subscriptions: every active team member can now see their team's plan
-- (tier, seats, status), not just whoever happened to run checkout. Still
-- read-only for authenticated users -- all writes remain service-role only
-- (stripe-webhook.js).
alter policy "Own subscription read-only" on public.subscriptions
  using (
    (team_id is not null and team_id in (select team_id from public.team_members where user_id = (select auth.uid()) and status = 'active'))
    or (team_id is null and (select auth.uid()) = user_id)
  );
