-- Email sync: connected mailboxes, the message ledger, and the provenance
-- marker on contacts that email sync creates.
--
-- Scoping note: a mailbox is personal, not team property. email_accounts and
-- email_messages are user-scoped (auth.uid() = user_id) so a teammate can
-- never read another recruiter's mail ledger. The contacts and notes those
-- messages produce stay team-scoped, exactly as contacts already are — the
-- mailbox is yours, the contact it produced belongs to the team.
--
-- Applied to production 2026-09-05.

alter table public.contacts
  add column if not exists created_from text;

comment on column public.contacts.created_from is
  'Provenance. NULL = typed or imported by hand. ''email_sync'' = created automatically from a connected mailbox.';

create index if not exists contacts_created_from_idx
  on public.contacts (user_id, created_from) where created_from is not null;

create table if not exists public.email_accounts (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  unipile_account_id   text not null unique,
  email_address        text not null,
  provider             text,
  status               text not null default 'connected',
  connected_at         timestamptz not null default now(),
  last_synced_at       timestamptz,
  backfill_done        boolean not null default false,
  backfill_cursor      text,
  last_error           text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint email_accounts_status_chk
    check (status in ('connecting','connected','disconnected','error')),
  constraint email_accounts_user_address_uniq unique (user_id, email_address)
);

create index if not exists email_accounts_user_idx on public.email_accounts (user_id);

alter table public.email_accounts enable row level security;

drop policy if exists email_accounts_own on public.email_accounts;
create policy email_accounts_own on public.email_accounts
  for all
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- The ledger. One row per logged message.
--
-- Deliberately absent: any column holding the message body. Annie reads the
-- mail, writes a note, and drops it. What is kept is who, when, and what was
-- said in one line — not the email.
--
-- The unique constraint on (account_id, provider_message_id) is what makes a
-- webhook retry free: ingest claims the row first, and a duplicate delivery
-- fails that insert instead of writing a second note and paying for it twice.
create table if not exists public.email_messages (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  account_id           uuid not null references public.email_accounts(id) on delete cascade,
  provider_message_id  text not null,
  thread_id            text,
  direction            text not null,
  counterparty_email   text not null,
  counterparty_name    text,
  counterparty_domain  text not null,
  contact_id           uuid references public.contacts(id) on delete set null,
  subject              text,
  sent_at              timestamptz not null,
  is_auto_reply        boolean not null default false,
  away_until           date,
  note                 text,
  note_model           text,
  created_at           timestamptz not null default now(),
  constraint email_messages_direction_chk check (direction in ('in','out')),
  constraint email_messages_provider_uniq unique (account_id, provider_message_id)
);

create index if not exists email_messages_contact_idx
  on public.email_messages (contact_id, sent_at desc);
create index if not exists email_messages_user_sent_idx
  on public.email_messages (user_id, sent_at desc);
create index if not exists email_messages_thread_idx
  on public.email_messages (account_id, thread_id);
create index if not exists email_messages_domain_idx
  on public.email_messages (user_id, counterparty_domain);

alter table public.email_messages enable row level security;

drop policy if exists email_messages_own on public.email_messages;
create policy email_messages_own on public.email_messages
  for all
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
