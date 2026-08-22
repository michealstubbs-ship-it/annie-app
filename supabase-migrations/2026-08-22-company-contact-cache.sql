-- A verified hiring-manager contact (name, title, LinkedIn, email) is a
-- company-level fact, exactly like domain/industry already cached in
-- company_enrichment — it doesn't change per-signal. Before this,
-- verifyContact() in scanShared.js had zero caching at all: every signal
-- that mentioned a company spent a fresh Apollo people-search credit (plus a
-- second credit for the email reveal), even if the same company's contact
-- had just been resolved moments earlier for a different signal in the same
-- run. This becomes a real cost problem with the Live Jobs feature, which
-- can surface several entries (one per open role) for the same company in a
-- single run.
--
-- These columns let verifyContact() check company_enrichment first (keyed
-- by the same company_name_key as the rest of that table) and skip the
-- Apollo spend entirely on a cache hit within a TTL, including a cached
-- NEGATIVE result (contact_verified = false — "already tried, nobody
-- findable") so a company that never yields a contact isn't retried on
-- every single run either.
--
-- Applied directly to the live DB via the Supabase MCP on 2026-08-22 (named
-- `company_enrichment_contact_cache`). Run this once in the Supabase SQL
-- Editor if setting up a fresh environment.
alter table public.company_enrichment
  add column if not exists contact_name text,
  add column if not exists contact_title text,
  add column if not exists contact_linkedin_url text,
  add column if not exists contact_email text,
  add column if not exists contact_verified boolean,
  add column if not exists contact_checked_at timestamptz;
