-- 2026-09-06, gap-analysis batch 3 ("silver-medalist / job-change
-- reactivation alerts"): today a strong candidate who didn't get placed
-- just sits at 'rejected' — nothing tracks them for the next relevant
-- role. This extends the existing is_hotlisted mechanic (candidates.js's
-- own 2026-09-03 header comment: "candidate-LED marketing") with a
-- second, narrower flag scoped specifically to a candidate who was
-- rejected but is worth revisiting — distinct from hotlist, which is
-- "market this person proactively right now" regardless of stage.
--
-- Honesty note (kept here, not just in code comments, since it matters
-- for what this migration is NOT): there is no real job-change-detection
-- signal wired up here (that would need a web-monitoring integration this
-- build doesn't have) — this is a recruiter-set "keep this person on your
-- radar" flag with a simple filter to review them periodically, not an
-- automated "they just changed jobs" notification. RecruiterFlow's "Job
-- Change Alerts" (the researched 2026 benchmark) is the real automated
-- version of this; this is the honest, buildable-today first step.
alter table candidates
  add column if not exists watch_for_reactivation boolean not null default false,
  add column if not exists reactivation_note text;

create index if not exists candidates_watch_for_reactivation_idx on candidates(watch_for_reactivation) where watch_for_reactivation = true;

comment on column candidates.watch_for_reactivation is 'Recruiter-set: a rejected (or otherwise not-currently-placed) candidate worth revisiting for the next relevant role. A manual review flag, not an automated job-change detector.';
