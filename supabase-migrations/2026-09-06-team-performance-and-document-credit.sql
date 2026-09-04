-- Team Performance dashboard, and the one schema gap it needs first.
--
-- Michael: "We already have an option to add terms of business to a
-- company. So, just add a drop down of who added them." The existing
-- company_documents upload (2026-09-04-company-documents.sql) only ever
-- stamps user_id, the uploader. That is often the right person, but not
-- always: an assistant can upload a scan on a recruiter's behalf, and the
-- person who actually closed the deal should get the credit, not whoever
-- happened to click Upload. credited_to is that explicit choice, editable
-- on the form, defaulting to the uploader via the trigger below so nobody
-- has to fill it in for the common case where they're the same person.
alter table public.company_documents
  add column if not exists credited_to uuid references auth.users(id);

update public.company_documents set credited_to = user_id where credited_to is null;

create or replace function public.fill_company_document_credit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.credited_to is null then
    new.credited_to := new.user_id;
  end if;
  return new;
end;
$$;
revoke execute on function public.fill_company_document_credit() from public, anon, authenticated;

drop trigger if exists trg_fill_company_document_credit on public.company_documents;
create trigger trg_fill_company_document_credit
  before insert on public.company_documents
  for each row execute function public.fill_company_document_credit();

create index if not exists company_documents_credited_to_idx on public.company_documents(credited_to);

comment on column public.company_documents.credited_to is 'Who gets credit for this document (usually a signed terms-of-business contract) for performance reporting. Defaults to the uploader, editable on the upload form.';

-- Team Performance itself reads straight from tables that already exist
-- (candidate_job_links, meetings, invoices, invoice_splits, jobs), no new
-- tables needed there, just indexes so the date-range reads the dashboard
-- runs on every page load and every period switch stay fast as those
-- tables grow.
create index if not exists candidate_job_links_owner_stage_changed_idx
  on public.candidate_job_links (owner_id, stage_changed_at);

create index if not exists meetings_user_id_meeting_date_idx
  on public.meetings (user_id, meeting_date);

create index if not exists invoices_job_id_issue_date_idx
  on public.invoices (job_id, issue_date);
