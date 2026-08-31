-- Applied live to both the annie app project and annie-staging via direct
-- database connection — kept here for the record, same as every other
-- migration in this folder.
--
-- 2026-08-31 audit fix: a live mandate (Head of Compliance, £31,900 fee)
-- vanished from both the open and closed sections of the Jobs page, and
-- Overview reported "0 on hold" despite this job clearly being on hold.
-- Root cause: every UI path that reads job status compares against the
-- literal string 'onhold' (Jobs.jsx, Overview.jsx, Companies.jsx,
-- lib/data/jobs.js, JobFormModal.jsx's own <option value="onhold">) — the
-- app itself never writes anything else. This record's status was stored as
-- 'on_hold' instead, almost certainly from a manual DB edit or import that
-- didn't go through JobFormModal. jobs.status had no constraint at all, so
-- nothing caught it — the row just silently fell through every filter (not
-- active/onhold -> not "open"; not filled/lost -> not "closed" either) and
-- disappeared from the product entirely, with no error anywhere.
--
-- Confirmed live on annie-staging before this ran: 7 active, 1 on_hold,
-- 1 filled — the on_hold row was exactly the missing mandate. Production
-- had 0 rows with a bad status at the time this ran, so only the CHECK
-- constraint has real effect there; applied anyway so the table can't
-- silently drift the same way once real customer jobs exist.
--
-- Two parts: normalize any existing rows already drifted from the four
-- canonical values (case/separator variants an import or typo could
-- plausibly produce), then add a CHECK constraint so this can never happen
-- silently again — a future bad status now fails loudly at write time
-- instead of quietly hiding a real mandate. NULL is left alone (a
-- genuinely unset status is a different, honest state, not this bug), and
-- the constraint permits it for the same reason — Postgres CHECK
-- constraints already pass NULL through by design.
update public.jobs
set status = 'onhold'
where status is not null
  and lower(regexp_replace(status, '[-_ ]', '', 'g')) = 'onhold'
  and status <> 'onhold';

update public.jobs
set status = 'active'
where status is not null and lower(status) = 'active' and status <> 'active';

update public.jobs
set status = 'filled'
where status is not null and lower(status) = 'filled' and status <> 'filled';

update public.jobs
set status = 'lost'
where status is not null and lower(status) = 'lost' and status <> 'lost';

alter table public.jobs
  add constraint jobs_status_check check (status in ('active', 'onhold', 'filled', 'lost'));
