-- Watchlist rotation: one timestamp per company, so the scan can stop
-- re-reading the same 40 names forever.
--
-- WHY THIS EXISTS. Measured on the production account the network-first release
-- shipped for, on 2026-09-05: 615 companies in the CRM, and
-- WATCHLIST_COMPANY_LIMIT = 40 of them searched per run. Because
-- getCustomerWatchlistCompanies ranked by relationship depth alone, and depth
-- does not change between two runs twelve hours apart, it returned the IDENTICAL
-- 40 companies every single time. 575 companies — 94% of the network the
-- customer spent years building — were never searched once, and never would be.
-- A company where the recruiter knows four people but which ranked 41st was not
-- deprioritised; it was permanently invisible.
--
-- The scan cannot fix that on its own because it has no memory. Nothing anywhere
-- recorded that a company had been looked at, so nothing could prefer the
-- company that had not been. This table is that memory, and it is the whole of
-- the new state: one row per (customer, company), holding when that company was
-- last searched. scanShared.js's selectWatchlistRotation reads it, keeps the
-- deepest WATCHLIST_CORE_SIZE relationships watched on every run, and gives the
-- remaining slots to whichever companies have gone longest unwatched.
--
-- No extra scan cost. This changes WHICH 40 companies a run searches, not how
-- many, so the Anthropic/Apollo/TheirStack spend per run is unchanged. The only
-- new work is one indexed read and one upsert per run, both against this table.
--
-- SAFE TO NOT APPLY IMMEDIATELY. scanShared.js treats a missing table as "no
-- rotation history": fetchWatchlistScanTimes returns an empty map and
-- recordWatchlistScan logs and moves on, both fail-open, exactly like
-- releaseApolloCredits already does for its own bookkeeping. In that state the
-- rotation still advances, because selectWatchlistRotation falls back to a
-- clock-derived block offset whenever staleness cannot order the pool. Applying
-- this migration upgrades the rotation from "advances on the clock" to
-- "advances on what has genuinely gone longest unwatched"; it does not switch
-- the feature on.

-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------
-- Keyed on user_id, not team_id, even though the watchlist itself pulls in a
-- teammate's companies and candidates (see getCustomerWatchlistCompanies).
-- Scans fire per onboarding row — that is, per user — so the thing that has to
-- advance run over run is one user's own cursor through their network. Two
-- teammates on the same CRM keep two independent rotations and will sometimes
-- both look at the same company; that costs nothing (the searches were going to
-- happen anyway, and the results are deduped per user downstream) and it avoids
-- one teammate's scan silently consuming the other's coverage.
--
-- company_key, not company_name, is the identity: it holds the output of
-- normalizeCompanyKey/normalizeCompanyName in src/lib/companyMatch.js, so "Acme
-- Ltd", "Acme Limited" and "Acme LTD." are one company here. Storing the raw
-- name as the key instead would let the same real company hold several rotation
-- rows and take several tail slots, being scanned twice as often as its
-- neighbours for no reason. company_name is carried alongside purely so this
-- table is legible to a human reading it during an investigation — nothing
-- joins or matches on it.
--
-- Normalisation deliberately happens in JS, not in a Postgres expression here.
-- companyMatch.js's suffix list is already the single definition used by the
-- signal dedup, the contact matching and the lead restriction; a second
-- definition written as a SQL regex would drift from it, which is the exact
-- failure this codebase has already had to fix for the scan prompt, RACY_TYPES
-- and company normalisation itself (see 20260905120000_network_first_core.sql's
-- own note on classification staying in JS).
create table if not exists public.watchlist_scans (
  user_id         uuid        not null references auth.users(id) on delete cascade,
  company_key     text        not null,
  company_name    text        not null,
  last_scanned_at timestamptz not null default now(),
  -- Not used by the rotation itself. It is the diagnostic that answers the one
  -- question this feature will actually be challenged on months from now — "has
  -- the sweep really been reaching the tail, or is the head being re-scanned?"
  -- A healthy account converges on a narrow spread of counts across all its
  -- companies; a wide spread means the recorder or the ordering is broken.
  scan_count      integer     not null default 1,
  primary key (user_id, company_key)
);

comment on table public.watchlist_scans is
  'When each of a customer''s companies was last searched by a scan. Read by scanShared.js selectWatchlistRotation to give the rotating watchlist slots to whatever has gone longest unwatched. One row per (user, normalised company name).';

comment on column public.watchlist_scans.company_key is
  'normalizeCompanyName() output from src/lib/companyMatch.js. Never normalised in SQL — one definition, in JS, shared with signal dedup and lead restriction.';

comment on column public.watchlist_scans.scan_count is
  'How many runs have searched this company. Diagnostic only; the rotation reads last_scanned_at.';

-- No secondary index. The only read is "every row for this user", which the
-- primary key's leading user_id column already serves, and the only write is a
-- point upsert on the full key. An index on last_scanned_at would be dead
-- weight: the ordering is done in JS over the customer's own few hundred rows,
-- because the tail order also depends on relationship depth, which lives in
-- contacts and is not queryable from here.

-- ---------------------------------------------------------------------------
-- 2. RLS
-- ---------------------------------------------------------------------------
-- A row here says "this customer has this company in their network", which is a
-- fact about the customer and never crosses a tenant boundary. Unlike
-- company_email_pattern_votes (20260905160000_email_patterns.sql) there is no
-- pooled aggregate to expose, so the customer's own rows are simply theirs to
-- read and nobody else's.
alter table public.watchlist_scans enable row level security;

create policy watchlist_scans_own
  on public.watchlist_scans
  for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 3. Recording a run
-- ---------------------------------------------------------------------------
-- One statement for all 40 companies rather than 40 upserts. That matters for
-- more than latency: scan_count is incremented inside the statement, so two
-- overlapping scans of the same account (the onboarding scan and the 12-hourly
-- cron can genuinely coincide) cannot both read a stale count and both write
-- the same value back. Same reasoning as apollo_reserve_credits' own atomic
-- reservation in 2026-08-26-per-customer-credit-caps.sql.
--
-- SECURITY INVOKER, with p_user_id passed explicitly. The scan functions call
-- this with the service-role client, which bypasses RLS and so needs no
-- definer rights; an authenticated caller passing somebody else's user_id is
-- stopped by the policy above rather than by a check written here. Definer
-- rights would have removed that guarantee for no gain.
--
-- Ordinality is what pairs the two arrays: the keys and the names arrive as
-- parallel arrays built from the same list in JS, and unnest(...) WITH
-- ORDINALITY is the only join between them that is defined by position rather
-- than by value. A name is optional — a key with no matching name still records
-- the scan, because the timestamp is the load-bearing part and losing a run's
-- rotation progress over a missing display string would be the wrong trade.
create or replace function public.record_watchlist_scan(
  p_user_id       uuid,
  p_company_keys  text[],
  p_company_names text[]
)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_rows integer;
begin
  if p_user_id is null or p_company_keys is null or array_length(p_company_keys, 1) is null then
    return 0;
  end if;

  insert into public.watchlist_scans (user_id, company_key, company_name, last_scanned_at, scan_count)
  select p_user_id, btrim(k.company_key), coalesce(nullif(btrim(n.company_name), ''), btrim(k.company_key)), now(), 1
    from unnest(p_company_keys) with ordinality as k(company_key, ord)
    left join unnest(coalesce(p_company_names, '{}'::text[])) with ordinality as n(company_name, ord)
      on n.ord = k.ord
   where k.company_key is not null
     and btrim(k.company_key) <> ''
  on conflict (user_id, company_key) do update
    set last_scanned_at = now(),
        company_name    = excluded.company_name,
        scan_count      = public.watchlist_scans.scan_count + 1;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

comment on function public.record_watchlist_scan(uuid, text[], text[]) is
  'Marks a run''s watchlist companies as searched. Called once per scan by scanShared.js recordWatchlistScan. Best-effort: a failure costs coverage speed, never a scan.';

grant execute on function public.record_watchlist_scan(uuid, text[], text[]) to authenticated;
