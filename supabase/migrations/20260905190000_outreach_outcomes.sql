-- Closing the outreach loop: what was sent, and whether it was answered.
--
-- NOT APPLIED to any database by the change that introduced it. Review first.
--
-- Apply this BEFORE or WITH the deploy that ships it, not after. The ingest
-- path writes email_messages.is_bounce on every message, and supabase-js
-- returns an unknown-column failure as a value rather than throwing — so on a
-- database without this migration the whole ledger patch is silently dropped,
-- taking contact_id and the note with it. Same ordering requirement as
-- 20260905090000_email_sync_core.sql; noted here because the failure is quiet.
--
-- Why a table rather than reading email_messages back
-- ---------------------------------------------------
-- email_messages already records every message Annie sees, so "did we mail
-- this address" is answerable today. What is NOT answerable is the question a
-- recruiter actually asks: which approaches worked. That needs three things a
-- mail ledger cannot carry:
--
--   1. the lead it came from (signal_id) — an approach is the last step of a
--      signal, and without the link the signal's outcome is unknowable
--   2. what was true at the moment of sending — whether the recruiter already
--      knew somebody else at that company, and how senior the recipient was.
--      Both drift: a contact added next week would silently rewrite last
--      week's history if these were computed at read time
--   3. one authoritative "answered" flag, decided ONCE by the reply rules in
--      emailIngest.js, rather than re-derived by every reader with its own
--      idea of what counts as a reply
--
-- Scoping matches email_messages: an approach is personal, because the mailbox
-- it was sent from is personal. A teammate must not read another recruiter's
-- outreach history.

-- --------------------------------------------------------------------------
-- A bounce is not an auto-reply, and neither is a reply.
--
-- The ledger already separates an out-of-office (is_auto_reply) from a real
-- answer. A delivery failure needs its own flag for the same reason: an
-- undeliverable notice matched to a contact and counted as "they answered"
-- would be the exact opposite of the truth. Nothing reads is_auto_reply to
-- mean "not a bounce", so a third state, not a widened second one.
alter table public.email_messages
  add column if not exists is_bounce boolean not null default false;

comment on column public.email_messages.is_bounce is
  'True when this inbound message is a delivery failure notice (DSN/NDR), not a message a person wrote. Never counts as contact and never answers an approach.';

-- --------------------------------------------------------------------------

create table if not exists public.outreach_approaches (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,

  -- The lead. Nullable and ON DELETE SET NULL on purpose: signals are pruned
  -- by data retention, and losing the signal must not lose the fact that an
  -- approach was made and answered.
  signal_id           uuid references public.intelligence_signals(id) on delete set null,
  signal_type         text,

  -- The person, and the message that carried it.
  contact_id          uuid references public.contacts(id) on delete set null,
  company_id          uuid references public.companies(id) on delete set null,
  company_name        text,
  to_email            text not null,
  subject             text,
  sent_at             timestamptz not null default now(),
  email_message_id    uuid references public.email_messages(id) on delete set null,
  thread_id           text,

  -- Snapshots, taken at send time and never recomputed. See the header.
  seniority_band      text,
  known_at_company    integer,

  -- The answer, written by exactly one place: markApproachReplied() in
  -- netlify/functions/lib/outreachApproach.js, called from the ingest path
  -- once a message has passed the auto-reply and bounce gates.
  replied_at          timestamptz,
  reply_message_id    uuid references public.email_messages(id) on delete set null,

  created_at          timestamptz not null default now()
);

-- One approach per message. The send path is idempotent for the same reason
-- ingest is: a retried request must not double-count an approach and halve the
-- reply rate the customer is shown.
create unique index if not exists outreach_approaches_message_uniq
  on public.outreach_approaches (email_message_id)
  where email_message_id is not null;

-- The readout's only query: this user's approaches, newest first.
create index if not exists outreach_approaches_user_sent_idx
  on public.outreach_approaches (user_id, sent_at desc);

-- Reply matching: open approaches to one address. Partial, because a closed
-- approach is never a candidate and there is no reason to index it.
create index if not exists outreach_approaches_open_idx
  on public.outreach_approaches (user_id, to_email)
  where replied_at is null;

create index if not exists outreach_approaches_signal_idx
  on public.outreach_approaches (signal_id)
  where signal_id is not null;

create index if not exists outreach_approaches_contact_idx
  on public.outreach_approaches (contact_id)
  where contact_id is not null;

alter table public.outreach_approaches enable row level security;

drop policy if exists outreach_approaches_own on public.outreach_approaches;
create policy outreach_approaches_own on public.outreach_approaches
  for all
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

comment on table public.outreach_approaches is
  'One row per approach actually sent from a connected mailbox, linked to the lead it came from and the contact it went to. replied_at is set only by the ingest path, only for a message that passed both the auto-reply and bounce gates.';
comment on column public.outreach_approaches.known_at_company is
  'How many OTHER contacts the user already had at this company when the approach was sent. Snapshot, never recomputed — a contact added later must not rewrite what was true at the time.';
comment on column public.outreach_approaches.seniority_band is
  'The recipient contact''s seniority_band at send time, or NULL when unknown. NULL is never treated as any band.';
