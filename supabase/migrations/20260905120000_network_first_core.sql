-- Network-first pivot: the organising fields the CRM never had, and the
-- collapse of three tiers into two.
--
-- WHY THIS EXISTS. Measured on a real account 2026-09-05, before any of this:
-- 753 imported contacts, of which `status` said 'cold' on 752, `tags` said
-- 'linkedin-import' on 752, `notes` was empty on 753 and `last_contacted` was
-- null on 753. Only name, company and title differed between any two rows, so
-- there was nothing to sort, group or rank by — the CRM was a flat list
-- wearing a CRM's clothes. Every column added here exists to make a row
-- distinguishable from the row below it.
--
-- Nothing here needs an API call or a credit. Seniority and function are
-- derived from title text the import already reads and already throws away;
-- connected_on is read off the CSV and thrown away today (it is used as a
-- filter on the import screen and never stored).

-- ---------------------------------------------------------------------------
-- 1. Relationship tier
-- ---------------------------------------------------------------------------
-- A LinkedIn connection is not a contact and neither is a client. Conflating
-- the three is what made the list feel undifferentiated. The ladder:
--
--   connection  you are connected; no reachable channel of your own.
--               Still generates leads — a job move at this person's employer
--               is a lead whether or not you can email them. The action is a
--               LinkedIn message or a call, not a send.
--   contact     you have a real channel: work email or phone.
--   client      evidence you have actually worked together — two-way email
--               history from the mailbox sync, or a logged placement.
--
-- Promotion happens on EVIDENCE, never at import time. Nothing in this
-- migration writes 'client'; only the mailbox backfill can earn that, because
-- only it can prove a two-way exchange happened.
alter table public.contacts
  add column if not exists relationship_tier text not null default 'connection';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'contacts_relationship_tier_chk'
  ) then
    alter table public.contacts
      add constraint contacts_relationship_tier_chk
      check (relationship_tier in ('connection','contact','client'));
  end if;
end $$;

comment on column public.contacts.relationship_tier is
  'connection = no reachable channel. contact = has email or phone. client = proven two-way history. Earned by evidence, never set at import.';

-- ---------------------------------------------------------------------------
-- 2. Relationship age
-- ---------------------------------------------------------------------------
-- The CSV's "Connected On" column. Read by linkedinImportParse.js today,
-- passed to passesConnectionAge() as an import filter, then discarded. It is
-- the only staleness signal that exists before a mailbox is connected, and
-- without it every contact grades identically as "never contacted" — which is
-- exactly what all 753 rows on the measured account did.
alter table public.contacts
  add column if not exists connected_on date;

comment on column public.contacts.connected_on is
  'Date the customer connected with this person on LinkedIn, from the CSV. Proxy for how long they have known each other.';

-- ---------------------------------------------------------------------------
-- 3. Derived facets: seniority and function
-- ---------------------------------------------------------------------------
-- Deliberately plain text columns with NO classification logic in SQL.
--
-- The vocabularies already exist in JS and are already unit-tested —
-- SENIORITY_OPTIONS in linkedinImportMatch.js, FLAT_FUNCTION_OPTIONS in
-- functionTaxonomy.js — and are shared with onboarding specifically so the two
-- can never drift apart (that file's own header records the bug that taught
-- this lesson). Reimplementing either as a Postgres regex would create a
-- second definition that silently disagrees with the first, which is the exact
-- failure mode this codebase has already had to fix three times (the
-- scan-prompt fork, the RACY_TYPES fork, the company-normalisation fork).
--
-- So: the columns live here, the classifier lives in src/lib/contactFacets.js,
-- and both the importer and the backfill call that one function.
alter table public.contacts
  add column if not exists seniority_band text;

alter table public.contacts
  add column if not exists function_area text;

comment on column public.contacts.seniority_band is
  'Derived from title by contactFacets.js deriveSeniorityBand(). Never classified in SQL — one definition, in JS, shared with the import filters.';

comment on column public.contacts.function_area is
  'Derived from title by contactFacets.js deriveFunctionArea(), using the same functionTaxonomy.js vocabulary onboarding uses.';

-- ---------------------------------------------------------------------------
-- 3b. Competitors in the network
-- ---------------------------------------------------------------------------
-- Found while validating the classifier against the real 753-contact network,
-- not anticipated: a recruiter's own LinkedIn connections include other
-- recruiters. "Managing Director | Finance & Accountancy Recruiter |
-- Headhunter" and "Managing Director, AI & Technology Recruitment & Executive
-- Search" both classify as C-suite, so without this flag the very first names
-- on a recruiter's own ranked call list would have been rival headhunters.
--
-- A flag rather than a deletion: they are real relationships and plausible
-- referral partners. Ranking excludes them, the CRM keeps them, and the
-- customer can still see and use them.
alter table public.contacts
  add column if not exists is_competitor boolean not null default false;

comment on column public.contacts.is_competitor is
  'True when the title or company looks like another recruiter or search firm. Set by contactFacets.js isLikelyCompetitor(). Excluded from lead ranking, never hidden from the CRM.';

-- ---------------------------------------------------------------------------
-- 3c. Parking a backlog lead
-- ---------------------------------------------------------------------------
-- Backlog leads are synthesised in the browser from contacts rather than
-- written as intelligence_signals rows (see src/lib/stream/backlogSignals.js
-- for why). That buys a great deal of simplicity and costs exactly one thing:
-- a synthetic row has nowhere to persist "not this one".
--
-- Actioning needs no column — logging a note sets last_contacted, and the
-- ranking already excludes anyone with last_contacted. Only an explicit
-- dismissal needs storing, and this is where it goes.
alter table public.contacts
  add column if not exists backlog_parked_at timestamptz;

comment on column public.contacts.backlog_parked_at is
  'Set when the recruiter explicitly dismisses this person from the backlog list. Contacting them is handled by last_contacted instead.';

-- Ranking the backlog reads (team, tier, seniority) and orders within it, so
-- the index carries the band and leaves connected_on to the sort.
create index if not exists contacts_backlog_idx
  on public.contacts (team_id, relationship_tier, seniority_band);

create index if not exists contacts_function_idx
  on public.contacts (team_id, function_area) where function_area is not null;

-- ---------------------------------------------------------------------------
-- 4. Backfill the tier from evidence already in the rows
-- ---------------------------------------------------------------------------
-- Safe in SQL because this is not classification, it is a fact check: does a
-- reachable channel exist on this row or not. Seniority and function are
-- backfilled separately from JS, for the reason given above.
--
-- 'client' is deliberately not assigned here. last_contacted is null on every
-- imported row, so there is no evidence to promote anyone on, and inventing
-- some would be exactly the kind of unearned claim this whole release is about
-- removing.
update public.contacts
   set relationship_tier = 'contact'
 where relationship_tier = 'connection'
   and (
     (email is not null and btrim(email) <> '')
     or (phone is not null and btrim(phone) <> '')
   );

-- ---------------------------------------------------------------------------
-- 5. Collapse the tiers: starter and growth both become solo
-- ---------------------------------------------------------------------------
-- Starter is removed rather than repriced. Under the network-first product the
-- mailbox IS the engine — dormancy, relationship strength and last-contacted
-- all come from email sync, and Starter never had email sync. A Starter
-- customer would be sold a plan that structurally cannot do what the product
-- promises, which is the precise failure this release exists to end.
--
-- Verified before writing this: all three Starter rows on production have no
-- stripe_subscription_id and 4-6 contacts each. They are Snag Week test
-- tenants. There are zero paying Starter customers to migrate.
--
-- Growth becomes Solo: the tiers now describe WHO the plan is for (one
-- recruiter, or a team) rather than an ambition. Team is unchanged.
--
-- Stripe still sends the old key in webhook metadata for existing
-- subscriptions, so entitlements.js keeps a legacy alias map
-- (starter -> solo, growth -> solo). Do not remove that alias until every
-- live subscription has been re-created against a new price.
update public.subscriptions
   set tier = 'solo'
 where tier in ('starter','growth');

do $$
begin
  if exists (
    select 1 from pg_constraint where conname = 'subscriptions_tier_chk'
  ) then
    alter table public.subscriptions drop constraint subscriptions_tier_chk;
  end if;
  alter table public.subscriptions
    add constraint subscriptions_tier_chk check (tier in ('solo','team'));
end $$;
