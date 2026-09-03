-- 2026-09-03: second oversights batch Michael flagged after the ownership/
-- attribution work ("is there any other oversights... normal recruitment
-- agency dynamic that I have missed?") — commission splits, guarantee/
-- rebate tracking, and counter-offer risk + candidate hotlisting.
--
-- Double-submission warnings and team-lead visibility need NO schema here:
-- double-submission reuses the existing email-based duplicate-check
-- pattern (findCandidateDuplicateByEmail/findContactDuplicateByEmail),
-- just scoped additionally by job_id — pure application logic, no new
-- columns. Team-lead visibility already exists: team_members.role
-- ('owner' vs 'member') already gates Billing.jsx's team activity view
-- (crm-sharing-model-and-signal-privacy.sql, 2026-08-24) — this migration
-- only extends what that view can show (placement performance), not the
-- permission model itself.

-- ---------------------------------------------------------------------
-- Guarantee / rebate tracking — lives on invoices, since that's already
-- the placement/fee record (job_id + candidate_id + company_id). 90 days
-- is the researched industry-standard default; "no_refund" (replacement
-- only, no money back) is the researched dominant model — both editable
-- per-invoice, never hardcoded elsewhere.
-- ---------------------------------------------------------------------
alter table invoices
  add column if not exists guarantee_days integer not null default 90,
  add column if not exists rebate_model text not null default 'no_refund',
  add column if not exists guarantee_starts_at date,
  add column if not exists rebate_triggered_at date,
  add column if not exists rebate_notes text;

alter table invoices
  add constraint invoices_rebate_model_check
  check (rebate_model in ('no_refund', 'pro_rated', 'full_refund'));

-- Guarantee clock starts when the placement is actually billed, not
-- whenever the row happens to be edited later — backfactive existing
-- invoices to their issue_date so nothing already sent is left with a
-- blank/nonsensical guarantee window.
update invoices set guarantee_starts_at = issue_date where guarantee_starts_at is null and issue_date is not null;

comment on column invoices.guarantee_days is 'Guarantee/rebate window length in days from guarantee_starts_at. Default 90 (industry standard).';
comment on column invoices.rebate_model is 'What happens if the candidate leaves inside the guarantee window: no_refund (replacement only, most common), pro_rated, or full_refund.';
comment on column invoices.rebate_triggered_at is 'Set when a rebate/replacement was actually invoked — null means the guarantee period passed (or is still running) without incident.';

-- ---------------------------------------------------------------------
-- Commission/fee splits — one row per person credited on a placement,
-- following the researched Bullhorn model: a role_type (candidate_owner
-- vs job_owner side) each carrying its own split_pct among the people in
-- that role. Deliberately a separate table (not columns on invoices)
-- since a placement can have more than one person per side (e.g. a
-- handover mid-process) and a fixed number of columns can't express that.
-- ---------------------------------------------------------------------
create table if not exists invoice_splits (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  team_id uuid not null references teams(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  role_type text not null check (role_type in ('candidate_owner', 'job_owner')),
  split_pct numeric not null check (split_pct > 0 and split_pct <= 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (invoice_id, user_id, role_type)
);

create index if not exists invoice_splits_invoice_id_idx on invoice_splits(invoice_id);
create index if not exists invoice_splits_team_id_idx on invoice_splits(team_id);

alter table invoice_splits enable row level security;

create policy "Team members can view their team's invoice splits"
  on invoice_splits for select
  using (team_id in (select team_id from team_members where user_id = auth.uid() and status = 'active'));

create policy "Team members can manage their team's invoice splits"
  on invoice_splits for all
  using (team_id in (select team_id from team_members where user_id = auth.uid() and status = 'active'))
  with check (team_id in (select team_id from team_members where user_id = auth.uid() and status = 'active'));

-- ---------------------------------------------------------------------
-- Counter-offer risk + candidate hotlisting — both live directly on
-- candidates, since both are per-candidate-record judgments a recruiter
-- makes, same shape as the existing status/notes fields already there.
-- ---------------------------------------------------------------------
alter table candidates
  add column if not exists counter_offer_risk text,
  add column if not exists counter_offer_notes text,
  add column if not exists is_hotlisted boolean not null default false,
  add column if not exists hotlisted_at timestamptz,
  add column if not exists hotlist_note text;

alter table candidates
  add constraint candidates_counter_offer_risk_check
  check (counter_offer_risk is null or counter_offer_risk in ('low', 'medium', 'high'));

create index if not exists candidates_is_hotlisted_idx on candidates(is_hotlisted) where is_hotlisted = true;

comment on column candidates.counter_offer_risk is 'Recruiter-set risk that this candidate accepts a counter-offer from their current employer late in process. No competitor CRM has this as a named field per 2026-09-03 research — a genuine differentiator, not catch-up.';
comment on column candidates.is_hotlisted is 'Candidate-led (not job-led) marketing: available/strong candidate proactively marketed to clients without a specific open role, per the "hotlist" pattern (Vincere) researched 2026-09-03.';
