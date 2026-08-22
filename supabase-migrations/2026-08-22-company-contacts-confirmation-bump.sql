-- Feedback half of the company_contacts cache (see
-- 2026-08-22-company-contacts-per-title.sql for the cache itself). Until
-- now, verifyContact() populated company_contacts from Apollo alone and
-- nothing ever fed real-world confirmation back into it. But a customer
-- adding a signal's contact to their own CRM (addToCrm in
-- IntelligenceFeed.jsx) is a much stronger signal than Apollo's raw guess —
-- a human looked at that name/title and decided it was worth pursuing.
--
-- confirmed_by_customers counts how many times a cached contact has been
-- confirmed this way (a simple, soft confidence signal — occasional
-- undercounting from a rare concurrent bump is fine, this isn't a billing
-- ledger). bump_contact_confirmation() also refreshes checked_at and sets
-- contact_verified = true, extending how long the cache trusts that row
-- before it would otherwise re-check with Apollo.
--
-- Deliberately update-only (see bump_contact_confirmation's WHERE clause):
-- if a signal has a contact_name at all, verifyContact() already wrote that
-- contact to company_contacts when the signal was created, so there's
-- always a matching row to confirm. A key that doesn't match anything is a
-- safe no-op, not an error.
--
-- Locked to service_role from the start (same lesson as
-- 2026-08-21-lock-down-security-definer-functions.sql: a SECURITY DEFINER
-- function with no execute restriction is callable by anyone, logged in or
-- not, over PostgREST — this one is only ever meant to be called from
-- netlify/functions/confirm-contact.js using the service role).
--
-- Applied directly to the live DB via the Supabase MCP on 2026-08-22 (named
-- `company_contacts_confirmation_bump`). Run this once in the Supabase SQL
-- Editor if setting up a fresh environment.

alter table public.company_contacts
  add column if not exists confirmed_by_customers integer not null default 0;

create or replace function public.bump_contact_confirmation(p_company_key text, p_title_key text)
returns void
language plpgsql
security definer
as $$
begin
  update public.company_contacts
  set confirmed_by_customers = confirmed_by_customers + 1,
      contact_verified = true,
      checked_at = now()
  where company_name_key = p_company_key and title_key = p_title_key;
end;
$$;

alter function public.bump_contact_confirmation(text, text) set search_path = public;

revoke execute on function public.bump_contact_confirmation(text, text) from public, anon, authenticated;
grant execute on function public.bump_contact_confirmation(text, text) to service_role;
