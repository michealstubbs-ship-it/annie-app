-- SUPERSEDES the contact-cache columns added in
-- 2026-08-22-company-contact-cache.sql (contact_name/contact_title/
-- contact_linkedin_url/contact_email/contact_verified/contact_checked_at on
-- company_enrichment), which assumed a verified contact is a pure
-- company-level fact — like domain or industry.
--
-- That assumption was wrong: which contact is "the right one" at a company
-- depends on which title/role was being searched for. A CFO surfaced for a
-- funding signal is not "the verified contact" for a Head of Engineering
-- role at the same company. This was latent until the Live Jobs feature
-- made "several different roles at one company in a single scan run" a
-- normal case, not an edge case — at which point the company-only cache
-- would confidently serve back the wrong person for a different role.
--
-- company_contacts adds the missing dimension: it's keyed by
-- (company_name_key, title_key), where title_key is titleBucketKey() in
-- scanShared.js — an order-independent, case-insensitive signature derived
-- from the titleKeywords array being searched for (falls back to 'general'
-- when no title keywords are given). Same role at a company → cache hit,
-- shared across customers/signals. Different role at the same company →
-- separate cache entry, so it's resolved (and cached) independently.
--
-- The now-superseded contact_* columns on company_enrichment are left in
-- place, unused, rather than dropped — same non-destructive pattern already
-- used for candidate_angles elsewhere in this schema.
--
-- Applied directly to the live DB via the Supabase MCP on 2026-08-22 in two
-- steps (named `company_contacts_per_title` and
-- `company_contacts_rls_match_convention`). Run this once in the Supabase
-- SQL Editor if setting up a fresh environment.

create table if not exists public.company_contacts (
  id uuid primary key default gen_random_uuid(),
  company_name_key text not null,
  title_key text not null,
  contact_name text,
  contact_title text,
  contact_linkedin_url text,
  contact_email text,
  contact_verified boolean not null default false,
  checked_at timestamptz not null default now()
);

create unique index if not exists company_contacts_company_title_key
  on public.company_contacts (company_name_key, title_key);

alter table public.company_contacts enable row level security;

-- Matches company_enrichment's established convention: this is a shared,
-- cross-customer cache table. Writes only ever happen server-side via the
-- Netlify functions' service-role key, which bypasses RLS regardless of the
-- policies present — this SELECT policy is what lets any logged-in customer
-- read the cache (e.g. if the frontend ever needs to show cache state),
-- not what protects writes.
create policy company_contacts_select_authenticated
  on public.company_contacts
  for select
  to authenticated
  using (true);
