-- Second "recovered" file, same purpose and same rule as
-- 2026-08-24-recovered-undocumented-schema-gaps.sql: does NOT need to be
-- re-run against the live project (production already has all of this) —
-- it exists purely so the repo's migration history can actually
-- reconstruct production from an empty database (a fresh staging project,
-- disaster recovery, a new engineer), which the first recovered file
-- itself could not fully do, since these five changes were applied to
-- production AFTER it was written.
--
-- Found during a 5th-pass audit's migration-drift check (2026-08-26):
-- cross-referencing every migration Supabase's own migration history
-- records as applied to production (list_migrations) against every .sql
-- file actually checked into supabase-migrations/ turned up five
-- production migrations with no corresponding file anywhere in the repo —
-- unlike the two "recovered" files' entire reason for existing, these
-- weren't even flagged as a known gap before now. Every statement below
-- was written by reading the ACTUAL current definition off production
-- directly (pg_get_functiondef, pg_policies, information_schema.columns) —
-- not reconstructed from memory of what each fix was supposed to do — so
-- this reflects exactly what's live today, same discipline as the first
-- recovered file.
--
-- The five gaps:
--
--   1. annie_learned_sources (production migration "annie_learned_sources",
--      2026-08-25) — the table backing getLearnedSources/
--      recordLearnedDiscoveries in scanShared.js (Annie's own growing
--      research memory of companies/sources worth checking per sector +
--      market, seeded with anchors and grown over time — see that
--      function's own header comment). Referenced by name in scanShared.js
--      and scanShared.test.js, but the CREATE TABLE itself was never
--      checked in.
--
--   2. Two admin-RPC bugfixes applied the same day admin_operator_dashboard
--      first shipped (production migrations
--      "fix_team_members_rls_recursion" and
--      "fix_admin_rpc_ambiguous_columns_and_is_admin_guard", both
--      2026-08-24) — a self-referencing team_members RLS policy that
--      recursed into itself, and one or more admin RPCs with an ambiguous
--      column reference and/or a missing is_admin guard. Both are already
--      correctly reflected in every admin RPC's live definition (each one
--      explicitly raises 'Not authorized' unless profiles.is_admin is
--      true, confirmed directly against production during this same
--      audit pass) and in team_members' one live policy below (delegates
--      to the SECURITY DEFINER my_active_team_ids() rather than querying
--      team_members from within team_members' own policy, which is what
--      actually avoids the recursion) — there was nothing left needing a
--      code fix, only a missing record of what production already has.
--
--   3. protect_team_id() bugfix (production migration
--      "fix_protect_team_id_current_user_bug", 2026-08-25) — this trigger
--      function blocks a non-service-role UPDATE from changing a row's
--      team_id. The live definition below is the fixed version; whatever
--      the pre-fix "current_user bug" actually was is lost to history, but
--      reconstructing from an empty database only ever needs the current,
--      correct version, same as every other function in both recovered
--      files.
--
--   4. get_account_requests() ambiguous-id bugfix (production migration
--      "fix_get_account_requests_ambiguous_id", 2026-08-25) — the version
--      checked into 2026-08-21-source-verification-and-account-requests.sql
--      predates this fix. Re-declared below with CREATE OR REPLACE so
--      reconstructing from empty picks up the corrected version instead of
--      the stale one from that earlier file.
create table if not exists public.annie_learned_sources (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('company', 'source')),
  sector text not null,
  location text not null,
  value text not null,
  value_key text not null,
  found_via text,
  first_seen_at timestamptz not null default now(),
  last_confirmed_at timestamptz not null default now(),
  unique (kind, sector, location, value_key)
);
create index if not exists annie_learned_sources_lookup_idx on public.annie_learned_sources (kind, sector, location);

alter table public.annie_learned_sources enable row level security;
create policy "annie_learned_sources_select_authenticated" on public.annie_learned_sources
  for select to authenticated using (true);
-- Server-side only (getLearnedSources/recordLearnedDiscoveries both run
-- from Netlify functions under the service role, which bypasses RLS) — no
-- insert/update/delete policy exists for authenticated on purpose, same
-- pattern as every other Annie-written, customer-read table in this repo.

-- ── 2. team_members' one live policy (the non-recursive version) ────────
--
-- 2026-08-27 audit fix: this section referenced my_active_team_ids() in the
-- policy below without ever defining it anywhere in the repo — reconstructing
-- from an empty database would have failed on this exact statement. Added
-- here, pulled directly from production via pg_get_functiondef (not
-- reconstructed from memory), same discipline as everything else in this
-- file. Also added `drop policy if exists` first — every other create
-- policy/create table in this file already guards for re-run safety
-- (`if not exists` throughout), this one line hadn't matched that.
create or replace function public.my_active_team_ids()
returns setof uuid
language sql stable security definer
set search_path to 'public'
as $$
  select team_id from public.team_members
  where user_id = auth.uid() and status = 'active'
$$;

drop policy if exists "Members can view their team roster" on public.team_members;
create policy "Members can view their team roster" on public.team_members
  for select to authenticated
  using (team_id in (select my_active_team_ids()));

-- ── 3. protect_team_id() — fixed version ─────────────────────────────────
create or replace function public.protect_team_id()
returns trigger as $$
begin
  if NEW.team_id is distinct from OLD.team_id and coalesce(auth.role(), '') <> 'service_role' then
    NEW.team_id := OLD.team_id;
  end if;
  return NEW;
end;
$$ language plpgsql security definer set search_path = public;

-- ── 4. get_account_requests() — ambiguous-id-fixed version ──────────────
create or replace function public.get_account_requests()
returns table(id uuid, created_at timestamptz, email text, request_type text, status text, note text)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true) then
    raise exception 'Not authorized';
  end if;

  return query
  select ar.id, ar.created_at, ar.email, ar.request_type, ar.status, ar.note
  from public.account_requests ar
  order by ar.created_at desc
  limit 500;
end;
$function$;
