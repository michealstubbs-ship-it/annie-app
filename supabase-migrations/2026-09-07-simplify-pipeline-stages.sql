-- 2026-09-07, Michael, real report: looking at a candidate's stage-progress
-- checklist (Sourced, Screening, Shortlisted, Presented, Interviewing,
-- Offer, Placed) he said "there is too many options here. He can get rid
-- of sourced, screening and presented." Confirmed scope: this collapses the
-- pipeline down to four working stages, Shortlisted, Interviewing, Offer,
-- Placed, plus the two terminal outcomes Rejected/Withdrawn that were
-- already tracked separately from the main progression (see
-- candidatesView.js's own MAIN_STAGES split, unchanged by this migration).
--
-- Existing candidates/links sitting in one of the three retired stages
-- collapse forward into Shortlisted, the new first stage, rather than being
-- silently reset to some other value or left holding an now-invalid stage
-- string. Shortlisted is the right landing spot: every candidate who was
-- merely sourced, or mid-screening, or presented to the client, is by
-- definition not yet interviewing, offered, or placed, so folding them into
-- the new earliest working stage keeps their position in the funnel honest
-- (nobody jumps ahead of where they actually were) without inventing a new
-- bucket just to hold three retired names.
update public.candidates set status = 'shortlisted' where status in ('sourced', 'screening', 'presented');
update public.candidate_job_links set stage = 'shortlisted', stage_changed_at = now() where stage in ('sourced', 'screening', 'presented');

alter table public.candidate_job_links drop constraint if exists candidate_job_links_stage_check;
alter table public.candidate_job_links
  add constraint candidate_job_links_stage_check
  check (stage in ('shortlisted', 'interviewing', 'offer', 'placed', 'rejected', 'withdrawn'));

-- New pipeline entries (both the "add candidate to pipeline" picker on
-- JobPipeline.jsx, which never sets stage explicitly, and the sync trigger
-- backfilling a primary link from a freshly-created candidate) now land on
-- Shortlisted, the new first working stage, instead of the retired
-- 'sourced' default.
alter table public.candidate_job_links alter column stage set default 'shortlisted';

comment on column public.candidate_job_links.stage is '2026-09-07: pipeline simplified to shortlisted/interviewing/offer/placed (+ rejected/withdrawn) per Michael, dropping sourced/screening/presented as separate stages.';
