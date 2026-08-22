-- Reconciliation only — every index and policy below already exists live
-- today and predates this migration file. A scale-readiness audit
-- (2026-08-22) found the migrations folder didn't fully reflect production:
-- a fresh environment or disaster-recovery restore following these files
-- literally could not reproduce production's actual indexes or storage
-- policies. This file closes that gap — every statement is `if not exists`
-- / re-creates an identical policy, so running it against a database that
-- already has these (i.e. production) is a safe no-op.
--
-- Run this once in the Supabase SQL Editor if setting up a fresh
-- environment — it brings a brand-new database to parity with what's
-- actually live today.

-- Indexes already live (bd_tasks, candidates, companies, contacts,
-- intelligence_signals, jobs, meetings, signal_outcomes, the shared cache
-- tables) that were never captured in a checked-in migration file.
create index if not exists bd_tasks_user_status_idx on public.bd_tasks (user_id, status, due_date);
create index if not exists candidates_user_idx on public.candidates (user_id);
create index if not exists candidates_user_status_idx on public.candidates (user_id, status);
create index if not exists candidates_job_id_idx on public.candidates (job_id);
create index if not exists companies_user_name_idx on public.companies (user_id, name);
create index if not exists contacts_user_id_idx on public.contacts (user_id);
create index if not exists contacts_company_id_idx on public.contacts (company_id);
create unique index if not exists intelligence_signals_dedup_idx on public.intelligence_signals (user_id, dedup_key);
create index if not exists intelligence_signals_user_found_idx on public.intelligence_signals (user_id, found_at desc);
create index if not exists intelligence_signals_user_status_idx on public.intelligence_signals (user_id, status);
create index if not exists intelligence_signals_linked_contact_id_idx on public.intelligence_signals (linked_contact_id);
create index if not exists jobs_user_status_idx on public.jobs (user_id, status);
create index if not exists meetings_user_date_idx on public.meetings (user_id, meeting_date desc);
create index if not exists signal_outcomes_user_id_idx on public.signal_outcomes (user_id);
create index if not exists signal_outcomes_signal_id_idx on public.signal_outcomes (signal_id);
create unique index if not exists company_enrichment_key_idx on public.company_enrichment (company_name_key);
create unique index if not exists company_contacts_key_idx on public.company_contacts (company_name_key, title_key);

-- Storage: the candidate-cvs bucket (private, per-customer-folder RLS) —
-- confirmed live, never previously captured in a migration file. CV
-- downloads go through createSignedUrl (time-limited), never a public URL.
insert into storage.buckets (id, name, public)
values ('candidate-cvs', 'candidate-cvs', false)
on conflict (id) do nothing;

drop policy if exists candidate_cvs_select_own on storage.objects;
create policy candidate_cvs_select_own on storage.objects
  for select to authenticated
  using (bucket_id = 'candidate-cvs' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists candidate_cvs_insert_own on storage.objects;
create policy candidate_cvs_insert_own on storage.objects
  for insert to authenticated
  with check (bucket_id = 'candidate-cvs' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists candidate_cvs_update_own on storage.objects;
create policy candidate_cvs_update_own on storage.objects
  for update to authenticated
  using (bucket_id = 'candidate-cvs' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists candidate_cvs_delete_own on storage.objects;
create policy candidate_cvs_delete_own on storage.objects
  for delete to authenticated
  using (bucket_id = 'candidate-cvs' and (storage.foldername(name))[1] = auth.uid()::text);
