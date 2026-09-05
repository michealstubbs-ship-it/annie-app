-- The 18-month mailbox sweep: the interaction ledger, the resume state, and
-- the interaction history that finally makes contacts.relationship_tier =
-- 'client' something a row can actually earn.
--
-- NOT APPLIED. This file is written to be applied by whoever runs the release;
-- nothing in this branch has run it against any database.
--
-- ---------------------------------------------------------------------------
-- WHY THIS EXISTS
-- ---------------------------------------------------------------------------
-- The sweep that shipped before this one read 12 pages of 50 messages each way
-- and stopped — roughly 600 sent and 600 received, covering whatever period
-- that happened to be — and it called the Anthropic note writer on every
-- matched message. Extending that to 18 months without changing anything else
-- would have meant something like ten thousand model calls on the day a
-- customer signs up. The replacement reads METADATA ONLY (meta_only=true, 250
-- per request, no bodies), spends nothing on AI, and decides who is worth
-- filing from the shape of the correspondence instead of its contents.
--
-- THE PROMOTION RULE, which is what these tables are shaped around: a person
-- becomes a contact only if the conversation went BOTH WAYS — the recruiter
-- wrote to them AND they wrote back — inside the window. One-way mail is
-- newsletters, blasts, suppliers and no-reply addresses; a reply is a human
-- being choosing to answer. Everything that fails the test is KEPT here as
-- background interaction data and never written into public.contacts.
--
-- The failure being avoided is the LinkedIn CSV import, in the customer's own
-- words: "when I did mine it looked very messy with limited organisation."
-- That was 753 rows. An 18-month sweep that promoted every address it saw
-- would be the same complaint about several thousand.

-- ---------------------------------------------------------------------------
-- 1. email_interactions — one row per counterparty, promoted or not
-- ---------------------------------------------------------------------------
-- This is the table the rule needs and the ledger (public.email_messages) could
-- not be: email_messages is one row per MESSAGE and only exists for messages
-- the forward path ingested. The sweep needs one row per PERSON, accumulated
-- across up to 52,000 messages, with the two directions counted separately.
--
-- Note what is absent, exactly as in email_messages: any column holding a
-- message body, and any column holding a note. The sweep never fetches a body,
-- so there is nothing to keep even if someone wanted to.
--
-- Scoping matches email_accounts and email_messages: a mailbox is personal, not
-- team property, so this is user-scoped and a teammate can never read another
-- recruiter's correspondence graph. The contacts it promotes stay team-scoped,
-- as contacts already are.
create table if not exists public.email_interactions (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  account_id           uuid not null references public.email_accounts(id) on delete cascade,
  counterparty_email   text not null,
  counterparty_domain  text not null default '',
  counterparty_name    text,

  -- classifyAddress()'s verdict, stored rather than recomputed so the reason a
  -- person was or was not promoted survives a change to the address lists.
  --   person    a work address at a real company
  --   personal  free mail (gmail, hotmail, yahoo, outlook.com, icloud, ...)
  --   role      a company's front desk (info@, careers@, accounts@)
  kind                 text not null default 'person',

  -- The relationship, not just the name. Measured on the production account
  -- 2026-09-05: 753 contacts, and ZERO with any interaction history at all —
  -- last_contacted null on all 753, notes empty on all 753. That is why the
  -- "you have actually spoken to this person" rung of the way-in ladder has
  -- never fired for anybody, for any customer. These four columns are the fix.
  messages_sent        integer not null default 0,
  messages_received    integer not null default 0,
  first_exchange_at    timestamptz,
  last_exchange_at     timestamptz,

  -- Counted, never credited toward messages_received. An out-of-office is not
  -- a reply: Hannah Wild's auto-responder arrived 40 seconds after Michael's
  -- mail, and counting that as "she wrote back" would promote every address
  -- that happens to run a vacation responder — which is precisely the one-way
  -- blast the two-way rule exists to keep out. Bounces are folded in here for
  -- the stronger reason that the message never arrived at all.
  auto_replies         integer not null default 0,

  -- The decision, and why. Null means "not yet decided", which is the normal
  -- state for a one-way row: it stays undecided forever unless a reply arrives
  -- and makes it two-way. Storing the reason means "why is this person not in
  -- my CRM" has an answer that is a fact rather than a reconstruction.
  decided_at           timestamptz,
  promotion_outcome    text,
  contact_id           uuid references public.contacts(id) on delete set null,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint email_interactions_kind_chk
    check (kind in ('person','personal','role')),
  -- The upsert key. One row per person per mailbox; the sweep reads a page,
  -- merges it against what is stored, and writes absolute totals back, so a
  -- page re-read after an interrupted run cannot double-count.
  constraint email_interactions_person_uniq unique (account_id, counterparty_email)
);

-- The promotion pass's exact query: undecided rows for this account that now
-- pass the two-way test. Partial, because the one-way majority is the bulk of
-- the table and is never scanned.
create index if not exists email_interactions_undecided_idx
  on public.email_interactions (account_id)
  where decided_at is null;

create index if not exists email_interactions_user_idx
  on public.email_interactions (user_id, last_exchange_at desc);

create index if not exists email_interactions_domain_idx
  on public.email_interactions (user_id, counterparty_domain);

comment on table public.email_interactions is
  'One row per counterparty per mailbox, built by the 18-month metadata-only sweep. Holds everyone the sweep saw, INCLUDING the one-way senders that are deliberately never promoted to contacts.';

comment on column public.email_interactions.auto_replies is
  'Out-of-office and bounce messages. Counted but never credited toward messages_received — an auto-responder is not a human choosing to reply, and treating it as one would promote exactly the one-way blasts the two-way rule excludes.';

comment on column public.email_interactions.promotion_outcome is
  'two_way / created / matched_email / matched_name = filed as a contact. role_address = passed the two-way test and was deliberately held back (a contact called "info" helps nobody). Null with decided_at null = one-way, still background data.';

alter table public.email_interactions enable row level security;

drop policy if exists email_interactions_own on public.email_interactions;
create policy email_interactions_own on public.email_interactions
  for all
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- 2. Interaction history on the contact itself
-- ---------------------------------------------------------------------------
-- Mirrored from email_interactions rather than joined, because every screen
-- that wants it — the contact card, the backlog ranking, the way-in ladder —
-- reads contacts and nothing else. The mirror only ever carries PROMOTED
-- people; the un-promoted stay in email_interactions where they belong.
--
-- Deliberately not a view. relationship_tier is already a plain column on
-- contacts and these sit beside it, so the row remains self-describing.
alter table public.contacts
  add column if not exists first_exchange_at timestamptz;

alter table public.contacts
  add column if not exists last_exchange_at timestamptz;

alter table public.contacts
  add column if not exists messages_sent integer not null default 0;

alter table public.contacts
  add column if not exists messages_received integer not null default 0;

comment on column public.contacts.first_exchange_at is
  'Earliest message either way with this person, from the mailbox sweep. Null on every row that predates a connected mailbox.';

comment on column public.contacts.last_exchange_at is
  'Most recent message either way. Distinct from last_contacted, which is the CRM''s own "you touched this person" marker and only ever moves forward.';

comment on column public.contacts.messages_sent is
  'Outbound messages to this person inside the sweep window. With messages_received, this is the evidence behind relationship_tier = ''client'' — both must be > 0.';

-- Ranking asks "who have I actually spoken to, and how recently". Before the
-- sweep there was no answer on any row.
create index if not exists contacts_exchange_idx
  on public.contacts (team_id, last_exchange_at desc)
  where last_exchange_at is not null;

-- ---------------------------------------------------------------------------
-- 3. Resume state on the mailbox
-- ---------------------------------------------------------------------------
-- A 15-minute background function will not finish a mailbox of 52,000 messages
-- in one go, and the old sweep's answer to that was to stop after 12 pages and
-- call itself done. These columns are what let a big mailbox COMPLETE across
-- several runs instead of silently truncating.
--
-- backfill_cursor already existed (unused) and is reused as the page cursor.
alter table public.email_accounts
  add column if not exists sweep_role text;

alter table public.email_accounts
  add column if not exists sweep_after timestamptz;

alter table public.email_accounts
  add column if not exists sweep_started_at timestamptz;

alter table public.email_accounts
  add column if not exists sweep_completed_at timestamptz;

alter table public.email_accounts
  add column if not exists sweep_pages integer not null default 0;

alter table public.email_accounts
  add column if not exists sweep_messages integer not null default 0;

alter table public.email_accounts
  add column if not exists sweep_stats jsonb;

comment on column public.email_accounts.sweep_role is
  'Which phase of the sweep to resume: ''sent'', ''inbox'', or ''promote'' (both mailbox passes done, only the promotion queue left). Null when the sweep is finished or has not started.';

comment on column public.email_accounts.sweep_after is
  'The window start, pinned on the FIRST run and reused by every resumption. Recomputing "18 months ago" per invocation would slide the window forward between runs and leave a gap nobody would notice.';

comment on column public.email_accounts.sweep_stats is
  'The finished sweep''s tally. freeMailTwoWay counts the promoted people who wrote from a personal address and therefore carry no company: real contacts that produce no company signals, because gmail.com is not an employer to watch.';
