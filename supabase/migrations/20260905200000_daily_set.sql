-- The feed gets a bottom to it.
--
-- Until now the Intelligence Feed held eight backlog leads and refilled itself
-- from a pool of ~600 eligible contacts the moment one was worked. On the
-- measured 753-contact account that is six hundred senior relationships behind
-- a list that never got shorter: no end to the day, no sense of progress, and
-- no reason to open the product tomorrow rather than whenever.
--
-- The feed now shows a fixed set per day (src/lib/stream/dailySet.js), worked
-- down and finished. Two things needed somewhere to live for that to be true
-- across a reload and across devices, and both are here.
--
-- Nothing in this file changes what any existing query returns. The app runs
-- unchanged before it is applied: the daily set falls back to localStorage,
-- and Working on a backlog card falls back to lasting only until a reload.

-- ---------------------------------------------------------------------------
-- 1. Work in progress on a backlog lead
-- ---------------------------------------------------------------------------
-- Backlog leads are synthesised in the browser from contacts rather than
-- written as intelligence_signals rows (see src/lib/stream/backlogSignals.js
-- for why), so a synthetic row has nowhere of its own to record what the
-- recruiter is doing about it. 20260905120000_network_first_core.sql already
-- made that argument for a dismissal and added contacts.backlog_parked_at.
--
-- The same argument applies with more force to Working. Before this column the
-- New / Working / Park buttons on a backlog card wrote to intelligence_signals
-- by an id that matches no row there — they were dead controls. Losing
-- in-flight work is the one unforgivable bug in a feed, and a feed that cannot
-- store "I am on this" cannot avoid it.
alter table public.contacts
  add column if not exists backlog_working_at timestamptz;

comment on column public.contacts.backlog_working_at is
  'Set when the recruiter marks this person Working on a backlog card. Kept out of the feed''s main contacts select on purpose (see lib/data/backlogState.js) so a missing column degrades to "Working does not survive a reload", never to an empty feed.';

-- The read is "which of my contacts am I working", which is a handful of rows
-- out of hundreds, so the index only carries those.
create index if not exists contacts_backlog_working_idx
  on public.contacts (team_id)
  where backlog_working_at is not null;

-- ---------------------------------------------------------------------------
-- 2. Today's set
-- ---------------------------------------------------------------------------
-- The promise the feed makes is that the list at 9am is the list at 4pm. It is
-- kept by choosing membership ONCE per day and recording it, then reading the
-- record back on every later load instead of re-running the choice. Scores
-- move during a day — freshness decays, a colleague imports contacts, the scan
-- writes new signals, and above all the recruiter works a lead, which used to
-- hand up a replacement — and none of that is allowed to rewrite who is on
-- today's list.
--
-- One row per person per day. item_ids holds stream ids in the order they were
-- chosen, which is also the order they are shown: 'backlog:<contact uuid>' for
-- a relationship out of the CRM, an intelligence_signals uuid for everything
-- else. Deliberately text[] and deliberately not a foreign key — half of these
-- ids belong to rows that do not exist in any table, and a set from three
-- weeks ago should not resurrect or block anything.
--
-- This is a memo, not a source of truth. What actually happened to each lead
-- still lives where it always did: intelligence_signals.status, and
-- contacts.last_contacted / backlog_parked_at / backlog_working_at. Deleting
-- every row here would cost a redrawn day, not a lost decision.
create table if not exists public.daily_sets (
  user_id    uuid not null references auth.users(id) on delete cascade,
  day        date not null,
  item_ids   text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

comment on table public.daily_sets is
  'The finite set of leads shown to one recruiter on one day, in order. Written once when the day is first opened and read back unchanged for the rest of it — see src/lib/stream/dailySet.js.';

alter table public.daily_sets enable row level security;

-- Personal, like intelligence_signals and unlike the CRM tables: two
-- recruiters on the same team work different markets and different days.
-- No team branch anywhere in these policies, on purpose.
drop policy if exists daily_sets_select_own on public.daily_sets;
create policy daily_sets_select_own on public.daily_sets
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists daily_sets_insert_own on public.daily_sets;
create policy daily_sets_insert_own on public.daily_sets
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists daily_sets_update_own on public.daily_sets;
create policy daily_sets_update_own on public.daily_sets
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- No delete policy. Nothing in the product deletes a day, and an old set is
-- the only record of what someone was asked to work on.
