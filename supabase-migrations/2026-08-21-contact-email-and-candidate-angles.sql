-- Adds contact_email (Apollo-revealed email for the verified contact) and
-- candidate_angles (3 distinct candidate pitches instead of the old single
-- candidate_angle string) to intelligence_signals.
--
-- Applied directly to the live DB via the Supabase MCP on 2026-08-21 as part
-- of the same fix. Committing this file too so the schema history stays in
-- the repo — the whole reason the original "no intelligence generated"
-- incident happened was migration files existing here that were never
-- actually run against the live database. Run this once in the Supabase SQL
-- Editor if you're setting up a fresh environment from these files.
alter table public.intelligence_signals
  add column if not exists contact_email text,
  add column if not exists candidate_angles jsonb;

-- Also added the same day, same incident: Apollo's organization id, needed
-- to search people by company once Apollo deprecated name-based people
-- search (see the 2026-08-21 verifyContact fix — mixed_people/search
-- started returning 422 "deprecated for API callers" for every call).
-- Caching it here means the company lookup already done for company
-- enrichment doesn't have to be repeated just to also resolve people search.
alter table public.company_enrichment add column if not exists apollo_org_id text;
