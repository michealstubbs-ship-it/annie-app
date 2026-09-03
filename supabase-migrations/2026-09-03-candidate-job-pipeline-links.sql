-- 2026-09-03, Michael: "build the whole job [pipeline] mock you created" —
-- the real build behind mockups/pipeline-v2-mockup.html. The mockup's
-- single biggest feature is a candidate submitted to SEVERAL jobs at once
-- ("also in 2 other pipelines", the Candidate view toggle) — today,
-- candidates.job_id is one column, so a candidate can only ever be linked
-- to one job. Confirmed with Michael: build the real many-to-many model,
-- not a single-job-only first pass.
--
-- Design: one row per (candidate, job) pipeline entry, with its OWN stage,
-- interview schedule, and added-by/owner — distinct from (but kept in sync
-- with, for the primary link) candidates.status/owner_id. This is
-- deliberately additive: candidates.job_id/status are untouched and every
-- existing reader of them (Candidates.jsx's list/badges, the invoice
-- candidate picker, Jobs.jsx's suggested-candidates panel, invoice_splits)
-- keeps working exactly as today, because the trigger below keeps a
-- `is_primary = true` row for candidates.job_id perfectly in sync
-- automatically — no existing call site needs to change.

-- Pre-existing data-quality bug found while writing this migration: 4 real
-- candidates carry status='interview' (singular) — not one of the 9 real
-- stages (candidatesView.js's STAGES uses 'interviewing'). candidates.status
-- has never had its own check constraint, so this silently slipped through:
-- those 4 candidates show up under the "All" filter but never under
-- "Interviewing" specifically, and groupCandidatesByStage bucketed them
-- into a stray "Other" group. Fixed at the source, not just papered over in
-- the new table below.
update public.candidates set status = 'interviewing' where status = 'interview';

create table if not exists public.candidate_job_links (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  team_id uuid references public.teams(id) on delete cascade,
  -- The one link that mirrors candidates.job_id/status — see the sync
  -- trigger below. A candidate can have at most one primary link (their
  -- current candidates.job_id), and any number of secondary links (extra
  -- jobs they've been submitted to, added directly from the pipeline view).
  is_primary boolean not null default false,
  stage text not null default 'sourced'
    check (stage in ('sourced','screening','shortlisted','presented','interviewing','offer','placed','rejected','withdrawn')),
  -- Powers the mockup's "Nd in stage" age pill and the job header's "avg
  -- time in stage" / "aging >7d" stats — stamped now() on insert and reset
  -- every time `stage` actually changes (see the trigger and
  -- updatePipelineLinkStage in pipelineLinks.js), never touched otherwise.
  stage_changed_at timestamptz not null default now(),
  interview_round integer,
  interview_at timestamptz,
  -- Permanent record of who first submitted this candidate to this job —
  -- same "addedBy never changes" semantics as candidates/contacts/companies
  -- already established this session, just per pipeline entry instead of
  -- per record.
  added_by uuid references auth.users(id),
  owner_id uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (candidate_id, job_id)
);

create index if not exists candidate_job_links_candidate_id_idx on public.candidate_job_links (candidate_id);
create index if not exists candidate_job_links_job_id_idx on public.candidate_job_links (job_id);
create index if not exists candidate_job_links_team_id_idx on public.candidate_job_links (team_id);
-- The job pipeline board's own query: every link for one job, ordered
-- newest-changed first within a stage.
create index if not exists candidate_job_links_job_stage_idx on public.candidate_job_links (job_id, stage);

alter table public.candidate_job_links enable row level security;

create policy "Team members can view their team's pipeline links"
  on public.candidate_job_links for select
  using (team_id in (select team_id from public.team_members where user_id = (select auth.uid()) and status = 'active'));

create policy "Team members can manage their team's pipeline links"
  on public.candidate_job_links for all
  using (team_id in (select team_id from public.team_members where user_id = (select auth.uid()) and status = 'active'))
  with check (team_id in (select team_id from public.team_members where user_id = (select auth.uid()) and status = 'active'));

-- Keeps the PRIMARY link (candidates.job_id) in sync automatically, so no
-- existing insert/update path for candidates needs to know this table
-- exists. SECURITY DEFINER + explicit search_path, same pattern as every
-- other trigger function in this codebase (see fill_team_id()).
create or replace function public.sync_primary_candidate_job_link()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- The candidate moved off a job (or was cleared entirely) — drop the
  -- stale primary link for the OLD job rather than leaving an orphaned
  -- "primary" pointing at a job the candidate is no longer actually on.
  if (tg_op = 'UPDATE' and old.job_id is not null and old.job_id is distinct from new.job_id) then
    delete from public.candidate_job_links
      where candidate_id = new.id and job_id = old.job_id and is_primary = true;
  end if;

  if new.job_id is not null then
    insert into public.candidate_job_links
      (candidate_id, job_id, team_id, is_primary, stage, stage_changed_at, added_by, owner_id)
    values
      (new.id, new.job_id, new.team_id, true, new.status, now(), new.user_id, new.owner_id)
    on conflict (candidate_id, job_id) do update set
      is_primary = true,
      stage = excluded.stage,
      stage_changed_at = case
        when public.candidate_job_links.stage is distinct from excluded.stage then now()
        else public.candidate_job_links.stage_changed_at
      end,
      owner_id = excluded.owner_id,
      team_id = excluded.team_id,
      updated_at = now();
  end if;
  return new;
end;
$$;

revoke execute on function public.sync_primary_candidate_job_link() from public, anon, authenticated;

drop trigger if exists trg_sync_primary_candidate_job_link on public.candidates;
create trigger trg_sync_primary_candidate_job_link
  after insert or update of job_id, status, owner_id, team_id on public.candidates
  for each row execute function public.sync_primary_candidate_job_link();

-- Backfill: every candidate already linked to a job gets its primary
-- pipeline entry, stamped with whatever's already true today rather than
-- resetting everyone's "time in stage" clock to zero.
insert into public.candidate_job_links
  (candidate_id, job_id, team_id, is_primary, stage, stage_changed_at, added_by, owner_id, created_at, updated_at)
select c.id, c.job_id, c.team_id, true, c.status, coalesce(c.updated_at, c.created_at), c.user_id, c.owner_id, c.created_at, c.updated_at
from public.candidates c
where c.job_id is not null
on conflict (candidate_id, job_id) do nothing;

comment on table public.candidate_job_links is '2026-09-03: real many-to-many candidate<->job pipeline tracking behind the Pipeline v2 mockup. is_primary rows are auto-synced from candidates.job_id/status/owner_id by trg_sync_primary_candidate_job_link — never write is_primary=true from the app directly.';
