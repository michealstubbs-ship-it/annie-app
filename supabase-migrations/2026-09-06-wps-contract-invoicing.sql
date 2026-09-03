-- 2026-09-06, gap-analysis batch 3 ("WPS-aware contract invoicing"):
-- Annie's invoicing models a one-off permanent-placement fee — there's no
-- salary-cycle, Wage Protection System-shaped invoice for contract/temp
-- desks. UAE agencies placing contractors must submit a Salary
-- Information File every pay cycle (labour card number, wage account,
-- days worked, overtime), with penalties up to AED 5,000 per inaccurate
-- submission.
--
-- Deliberately plain columns on invoices (reusing the existing
-- invoice_splits/guarantee infrastructure, per the gap analysis's own
-- "Annie's edge" note), not a second billing model — this is a structured-
-- fields problem, not a payroll-system problem. is_wps_cycle is recruiter-
-- toggled (not inferred from job_type), same "the recruiter decides,
-- Annie doesn't guess" precedent as counter_offer_risk.
alter table invoices
  add column if not exists is_wps_cycle boolean not null default false,
  add column if not exists wps_labour_card_no text,
  add column if not exists wps_wage_account text,
  add column if not exists wps_days_worked integer,
  add column if not exists wps_overtime_hours numeric,
  add column if not exists wps_sif_due_date date;

comment on column invoices.is_wps_cycle is 'Recruiter-flagged: this invoice is a recurring contract/temp WPS salary cycle, not a one-off permanent-placement fee.';
comment on column invoices.wps_sif_due_date is 'When this cycle''s Salary Information File is due — surfaced as a task via "Flag SIF as due task" rather than tracked only here.';
