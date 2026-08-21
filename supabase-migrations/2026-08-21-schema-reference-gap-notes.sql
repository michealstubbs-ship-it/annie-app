-- REFERENCE ONLY — do not apply. Not a migration to run.
--
-- Pre-launch audit finding: several tables in the live database were never
-- captured in any checked-in migration file in this folder. That means the
-- migrations directory alone can't reconstruct the current schema, which is
-- a real risk (a fresh environment, a disaster-recovery restore, or a new
-- engineer reading migrations to understand the schema would all be missing
-- pieces). Short of a full migration history rewrite (risky, and not
-- necessary pre-launch), this file documents the live shape of those tables
-- as of 2026-08-21, taken directly from the running Supabase project via
-- `list_tables`. Treat it as a snapshot for reference and disaster-recovery,
-- not as something to run — running it against a database that already has
-- these tables would fail on the CREATE TABLE statements, and the `IF NOT
-- EXISTS` guards are there only so it's non-destructive if someone ignores
-- this warning and applies it to an EMPTY database, not as an endorsement
-- to do so.
--
-- Tables covered: intelligence_signals, candidates, jobs, companies,
-- meetings, bd_tasks, company_enrichment, signal_outcomes, and the
-- profiles.is_admin column (which predates this migrations folder).
--
-- All of these have RLS enabled in production; the exact policy definitions
-- are not reproduced here (they were added incrementally across several
-- migrations that ARE checked in — see
-- 2026-08-21-performance-rls-and-indexes.sql and
-- 2026-08-21-lock-down-security-definer-functions.sql for the RLS/RPC
-- patterns used elsewhere) — check the live project directly
-- (`list_tables` / `list_migrations` via the Supabase MCP tools, or the
-- Supabase dashboard) rather than trusting this file for policy text.

-- profiles.is_admin — gates the admin-only Insights page and the
-- get_error_logs()/get_account_requests() RPCs. Not added by any migration
-- in this folder; it predates this documentation effort.
-- ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_admin boolean DEFAULT false;

CREATE TABLE IF NOT EXISTS public.intelligence_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  company_name text NOT NULL,
  company_domain text,
  company_industry text,
  company_city text,
  company_state text,
  company_country text,
  company_logo_url text,
  signal_type text NOT NULL,
  headline text NOT NULL,
  why_it_matters text,
  source_url text,
  source_label text,
  found_at timestamptz NOT NULL DEFAULT now(),
  event_at timestamptz,
  contact_name text,
  contact_title text,
  contact_linkedin_url text,
  contact_verified boolean DEFAULT false,
  linked_contact_id uuid REFERENCES public.contacts(id),
  dedup_key text NOT NULL,
  status text NOT NULL DEFAULT 'new',
  created_at timestamptz NOT NULL DEFAULT now(),
  who_to_approach text,
  candidate_angle text,
  source_verified boolean NOT NULL DEFAULT false -- added 2026-08-21-source-verification-and-account-requests.sql, IS checked in
);

CREATE TABLE IF NOT EXISTS public.candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  job_id uuid REFERENCES public.jobs(id),
  name text NOT NULL,
  role text,
  company text,
  location text,
  industry text,
  email text,
  phone text,
  curr_sal integer,
  want_sal integer,
  notice_period text,
  availability text,
  linkedin_url text,
  status text NOT NULL DEFAULT 'sourced',
  source text,
  follow_up_date date,
  notes text,
  cv_path text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  name text NOT NULL,
  industry text,
  location text,
  website text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  company_id uuid NOT NULL REFERENCES public.companies(id),
  title text NOT NULL,
  salary_num numeric,
  fee_pct numeric,
  fee_value numeric,
  likelihood smallint NOT NULL DEFAULT 3,
  job_type text NOT NULL DEFAULT 'permanent',
  status text NOT NULL DEFAULT 'active',
  received date DEFAULT CURRENT_DATE,
  deadline date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  industry text
);

CREATE TABLE IF NOT EXISTS public.meetings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  contact_id uuid REFERENCES public.contacts(id),
  candidate_id uuid REFERENCES public.candidates(id),
  title text NOT NULL,
  meeting_type text NOT NULL DEFAULT 'call',
  meeting_date timestamptz NOT NULL,
  outcome text,
  next_steps text,
  follow_up_date date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.bd_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  contact_id uuid REFERENCES public.contacts(id),
  candidate_id uuid REFERENCES public.candidates(id),
  title text NOT NULL,
  notes text,
  due_date date,
  priority text NOT NULL DEFAULT 'normal',
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Shared enrichment cache, not scoped to a user — keyed by a normalised
-- company_name_key so repeat lookups across different users' contacts/deals
-- reuse one enrichment record instead of re-querying external APIs.
CREATE TABLE IF NOT EXISTS public.company_enrichment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name text NOT NULL,
  company_name_key text NOT NULL,
  domain text,
  industry text,
  city text,
  state text,
  country text,
  matched boolean DEFAULT false,
  enriched_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  logo_url text
);

-- signal_outcomes: added by 2026-08-21-signal-outcomes.sql, which IS
-- checked in — listed here only for completeness of this cross-reference,
-- no gap to document for it.
