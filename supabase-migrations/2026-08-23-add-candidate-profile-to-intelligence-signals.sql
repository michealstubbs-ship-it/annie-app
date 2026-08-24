-- Recovered file for a migration that was already applied live on
-- 2026-08-23 (tracked in Supabase as
-- `20260823115851_add_candidate_profile_to_intelligence_signals`) but never
-- had a corresponding .sql file committed to this repo — found during the
-- 2026-08-24 whole-app audit (Task 1) via list_migrations vs. the repo's
-- own supabase-migrations/ directory. This file exists purely so the repo
-- history matches what's actually live; it does not need to be re-run
-- against the current database (it already has this column), but keeps a
-- fresh environment set up from these files in sync going forward.

alter table public.intelligence_signals add column if not exists candidate_profile jsonb;
