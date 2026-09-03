-- Record ownership / attribution — Michael, 2026-09-03: "if a package is
-- sold with more than one seat... you need to see who added the candidate
-- in case there are any ownerships... this needs to apply across all
-- areas, including clients and contacts."
--
-- Confirmed with Michael: attribution + a team-member filter on top of the
-- existing fully-shared team view (every active member already sees every
-- candidate/contact/company) — NOT locked desks. Nobody's visibility or
-- edit access changes; this only makes "who added this" and "who owns
-- this now" visible and filterable.
--
-- Two separate concepts, deliberately not one column:
--   user_id (already exists on every one of these tables) stays exactly
--     what it's always been: who FIRST created the row. Immutable audit
--     fact, never touched by this migration.
--   owner_id (new) is who's WORKING it now — starts out equal to user_id,
--     but can be reassigned (desk handover, someone leaving, a manager
--     rebalancing a book of business) without rewriting history.
-- ownership_history logs every reassignment so a commission dispute months
-- later isn't a guessing game.
--
-- Purely additive, same posture as 2026-08-24-teams-and-shared-crm.sql:
-- nothing existing is dropped or renamed. Run once in the Supabase SQL
-- Editor if setting up a fresh environment (already applied directly to
-- the live DB via the Supabase MCP on 2026-09-03).

-- ---------------------------------------------------------------------
-- 1. owner_id on every team-scoped record table people "own" in the
--    desk/commission sense. (jobs included — a job/mandate has a desk
--    owner too, and it's the same trigger + zero extra code either way.)
-- ---------------------------------------------------------------------

alter table public.candidates add column if not exists owner_id uuid references auth.users(id);
alter table public.contacts add column if not exists owner_id uuid references auth.users(id);
alter table public.companies add column if not exists owner_id uuid references auth.users(id);
alter table public.jobs add column if not exists owner_id uuid references auth.users(id);

create index if not exists candidates_owner_id_idx on public.candidates(owner_id);
create index if not exists contacts_owner_id_idx on public.contacts(owner_id);
create index if not exists companies_owner_id_idx on public.companies(owner_id);
create index if not exists jobs_owner_id_idx on public.jobs(owner_id);

-- ---------------------------------------------------------------------
-- 2. Auto-fill owner_id = user_id on insert, same "zero application code
--    has to change" trigger pattern as fill_team_id() in
--    2026-08-24-teams-and-shared-crm.sql. A caller can still set owner_id
--    explicitly (not used yet, but future-proofs e.g. "add this candidate
--    on someone else's behalf"); this only fills it in when left blank.
-- ---------------------------------------------------------------------

create or replace function public.fill_owner_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.owner_id is null and new.user_id is not null then
    new.owner_id := new.user_id;
  end if;
  return new;
end;
$$;
revoke execute on function public.fill_owner_id() from public, anon, authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['candidates','contacts','companies','jobs']
  loop
    execute format('drop trigger if exists trg_fill_owner_id on public.%I', t);
    execute format('create trigger trg_fill_owner_id before insert on public.%I for each row execute function public.fill_owner_id()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 3. Backfill every existing row — owner starts as whoever created it.
-- ---------------------------------------------------------------------

update public.candidates set owner_id = user_id where owner_id is null;
update public.contacts set owner_id = user_id where owner_id is null;
update public.companies set owner_id = user_id where owner_id is null;
update public.jobs set owner_id = user_id where owner_id is null;

-- ---------------------------------------------------------------------
-- 4. Ownership history — one row per reassignment. from_owner_id is
--    nullable only to cover a record whose owner_id was somehow never set
--    (shouldn't happen after the backfill above, but fails closed rather
--    than blocking a legitimate reassignment on it).
-- ---------------------------------------------------------------------

create table if not exists public.ownership_history (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  table_name text not null check (table_name in ('candidates', 'contacts', 'companies', 'jobs')),
  record_id uuid not null,
  from_owner_id uuid references auth.users(id),
  to_owner_id uuid not null references auth.users(id),
  changed_by uuid not null references auth.users(id),
  changed_at timestamptz not null default now()
);
alter table public.ownership_history enable row level security;

create index if not exists ownership_history_record_idx on public.ownership_history(table_name, record_id);
create index if not exists ownership_history_team_id_idx on public.ownership_history(team_id);

create policy "Team members can view their team's ownership history" on public.ownership_history
  for select using (
    team_id in (select team_id from public.team_members where user_id = (select auth.uid()) and status = 'active')
  );

-- changed_by must be the caller (can't log a reassignment as someone
-- else), and the row's team_id must be a team the caller is an active
-- member of (same shape as every other team-scoped write check).
create policy "Team members can log ownership changes for their team" on public.ownership_history
  for insert with check (
    changed_by = (select auth.uid())
    and team_id in (select team_id from public.team_members where user_id = (select auth.uid()) and status = 'active')
  );
