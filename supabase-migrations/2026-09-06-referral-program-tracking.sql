-- 2026-09-06, gap-analysis batch 2 ("referral program tracking"):
-- "Referral" already exists as one option in candidates.source (a plain
-- free-text field) — this is what turns it into an actual program: WHO
-- referred them, and whether/how they were paid for it.
--
-- referrer_candidate_id links to an existing candidate when the referrer
-- is themselves someone already in the CRM (the common case — a placed
-- candidate referring a friend); referrer_name is the always-present
-- free-text fallback (a referrer who isn't a CRM record at all — a
-- client contact, a friend-of-the-agency). Both nullable; a candidate
-- with neither set is simply not a referral, same as today.
alter table candidates
  add column if not exists referrer_candidate_id uuid references public.candidates(id) on delete set null,
  add column if not exists referrer_name text;

create index if not exists candidates_referrer_candidate_id_idx on candidates(referrer_candidate_id);

comment on column candidates.referrer_candidate_id is 'Set when the person who referred this candidate is themselves an existing candidate record — auto-resolved by exact name match at save time (see Candidates.jsx), never a hard requirement.';
comment on column candidates.referrer_name is 'Free-text name of whoever referred this candidate — always set for a real referral even when referrer_candidate_id can''t be resolved to a CRM record.';

-- Payout tracking lives on the invoice, since that's the actual placement/
-- fee record (job_id + candidate_id + company_id) — same reasoning as the
-- 2026-09-03 guarantee/rebate fields living here rather than on candidates.
alter table invoices
  add column if not exists referral_payout_status text not null default 'none',
  add column if not exists referral_payout_amount numeric,
  add column if not exists referral_payout_notes text;

alter table invoices
  add constraint invoices_referral_payout_status_check
  check (referral_payout_status in ('none', 'pending', 'paid'));

comment on column invoices.referral_payout_status is 'none (not a referral placement), pending (owed, not yet paid), or paid.';
