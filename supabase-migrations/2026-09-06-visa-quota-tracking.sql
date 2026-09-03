-- 2026-09-06: first batch off "The Gulf Gap Analysis" (Michael: "build
-- everything in your gap analysis"). Visa/sponsorship tracking and
-- Emiratization/Saudization quota tracking — the two region/compliance
-- gaps ranked "regional edge": nothing in Annie tracks either today, and
-- no Western-built competitor CRM researched has them as real fields.
--
-- Same shape/precedent as the 2026-09-03 agency-dynamics-batch migration
-- (counter_offer_risk/is_hotlisted): plain columns on the existing table,
-- nullable/false-default so an ordinary candidate/company/job save is
-- completely unaffected.

-- ---------------------------------------------------------------------
-- Visa & sponsorship status — lives on candidates, since it's a
-- per-candidate fact a recruiter needs at a glance next to the existing
-- hotlist/counter-offer badges (same "five-minute glance" reasoning).
-- ---------------------------------------------------------------------
alter table candidates
  add column if not exists visa_status text,
  add column if not exists visa_type text,
  add column if not exists visa_sponsor text,
  add column if not exists visa_expiry date;

alter table candidates
  add constraint candidates_visa_status_check
  check (visa_status is null or visa_status in ('own_visa', 'needs_sponsorship', 'sponsored_by_agency', 'not_required'));

alter table candidates
  add constraint candidates_visa_type_check
  check (visa_type is null or visa_type in ('employment', 'golden', 'dependent', 'freelance', 'visit', 'other'));

comment on column candidates.visa_status is 'Whether this candidate already holds a transferable visa, needs sponsorship, is sponsored by this agency, or is a citizen/resident who does not need one. No competitor CRM researched has this as a real field (2026-09 gap analysis) — the single field every GCC recruiter needs first.';
comment on column candidates.visa_type is 'employment / golden / dependent / freelance / visit / other.';
comment on column candidates.visa_expiry is 'Drives the expiry-countdown badge in Candidates.jsx, same badge row as is_hotlisted/counter_offer_risk.';

create index if not exists candidates_visa_expiry_idx on candidates(visa_expiry) where visa_expiry is not null;

-- ---------------------------------------------------------------------
-- Emiratization / Saudization quota tracking — lives on companies (the
-- client's own regulatory band), with a per-job flag for whether that
-- role counts toward the client's quota.
-- ---------------------------------------------------------------------
alter table companies
  add column if not exists quota_current_pct numeric,
  add column if not exists quota_target_pct numeric,
  add column if not exists quota_deadline date,
  add column if not exists quota_band text,
  add column if not exists quota_notes text;

alter table companies
  add constraint companies_quota_band_check
  check (quota_band is null or quota_band in ('red', 'yellow', 'green', 'platinum', 'not_applicable'));

comment on column companies.quota_band is 'Client-entered regulatory standing — UAE Emiratization or Saudi Nitaqat-style band (red/yellow/green/platinum), or not_applicable for clients outside a quota-regulated market. Recruiter-maintained, not scraped.';
comment on column companies.quota_deadline is 'Next date this client''s national-hire quota is checked against (e.g. UAE''s end-of-year Emiratization threshold, or a Nitaqat review date).';

alter table jobs
  add column if not exists counts_toward_quota boolean not null default false;

comment on column jobs.counts_toward_quota is 'Whether filling this specific role would count toward the client company''s national-hire quota — lets a recruiter filter/flag quota-relevant roles separately from the client''s general quota_band standing.';
