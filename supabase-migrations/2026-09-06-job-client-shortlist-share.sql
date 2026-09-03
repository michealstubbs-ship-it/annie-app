-- 2026-09-06: gap-analysis batch 1, "client-facing shortlist link" — a
-- read-only, branded, live-updating view a client can open to see who's
-- been submitted for their role, replacing the manual email/screenshot
-- loop (per Vincere's own "LiveList" being one of its few genuinely
-- praised features on G2).
--
-- public_share_token is generated for every job up front (cheap, and
-- avoids a race/extra round-trip the first time a recruiter clicks "Get
-- client link") but is USELESS on its own — share_enabled must also be
-- explicitly turned on by the recruiter before the public endpoint
-- (netlify/functions/public-job-shortlist.js) will resolve it. Defense in
-- depth: even a leaked/guessed token does nothing for a job the recruiter
-- never chose to share.
alter table jobs
  add column if not exists public_share_token uuid not null default gen_random_uuid(),
  add column if not exists share_enabled boolean not null default false;

create unique index if not exists jobs_public_share_token_idx on jobs(public_share_token);

comment on column jobs.public_share_token is 'Unguessable id for the client-facing shortlist link (/share/job/:token). Generated for every job by default; inert unless share_enabled is also true.';
comment on column jobs.share_enabled is 'Recruiter has explicitly turned on the client-facing shortlist link for this job. Off by default — a token existing is not the same as a job being shared.';
