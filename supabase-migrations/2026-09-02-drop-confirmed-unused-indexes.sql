-- Drops 26 indexes confirmed via pg_stat_user_indexes (idx_scan = 0 since
-- creation), cross-checked against pg_index to exclude anything backing a
-- UNIQUE or PRIMARY KEY constraint. Original CREATE INDEX definitions kept
-- in comments below for reversibility.
-- Applied directly to production via Supabase MCP on 2026-09-02.

-- CREATE INDEX admin_ai_insights_status_idx ON public.admin_ai_insights (status);
drop index if exists public.admin_ai_insights_status_idx;

-- CREATE INDEX bd_tasks_candidate_id_idx ON public.bd_tasks (candidate_id);
drop index if exists public.bd_tasks_candidate_id_idx;

-- CREATE INDEX bd_tasks_contact_id_idx ON public.bd_tasks (contact_id);
drop index if exists public.bd_tasks_contact_id_idx;

-- CREATE INDEX candidates_job_id_idx ON public.candidates (job_id);
drop index if exists public.candidates_job_id_idx;

-- CREATE INDEX candidates_user_idx ON public.candidates (user_id);
drop index if exists public.candidates_user_idx;

-- CREATE INDEX chat_rate_limit_minute_bucket_idx ON public.chat_rate_limit (minute_bucket);
drop index if exists public.chat_rate_limit_minute_bucket_idx;

-- CREATE INDEX contact_notes_team_id_idx ON public.contact_notes (team_id);
drop index if exists public.contact_notes_team_id_idx;

-- CREATE INDEX contact_notes_user_id_idx ON public.contact_notes (user_id);
drop index if exists public.contact_notes_user_id_idx;

-- CREATE INDEX contacts_company_id_idx ON public.contacts (company_id);
drop index if exists public.contacts_company_id_idx;

-- CREATE INDEX contacts_follow_up_date_idx ON public.contacts (follow_up_date);
drop index if exists public.contacts_follow_up_date_idx;

-- CREATE INDEX deals_contact_id_idx ON public.deals (contact_id);
drop index if exists public.deals_contact_id_idx;

-- CREATE INDEX intelligence_signals_linked_contact_id_idx ON public.intelligence_signals (linked_contact_id);
drop index if exists public.intelligence_signals_linked_contact_id_idx;

-- CREATE INDEX invoice_line_items_invoice_id_idx ON public.invoice_line_items (invoice_id);
drop index if exists public.invoice_line_items_invoice_id_idx;

-- CREATE INDEX invoices_company_id_idx ON public.invoices (company_id);
drop index if exists public.invoices_company_id_idx;

-- CREATE INDEX invoices_job_id_idx ON public.invoices (job_id);
drop index if exists public.invoices_job_id_idx;

-- CREATE INDEX invoices_resend_email_id_idx ON public.invoices (resend_email_id);
drop index if exists public.invoices_resend_email_id_idx;

-- CREATE INDEX invoices_team_id_idx ON public.invoices (team_id);
drop index if exists public.invoices_team_id_idx;

-- CREATE INDEX jobs_company_idx ON public.jobs (company_id);
drop index if exists public.jobs_company_idx;

-- CREATE INDEX meetings_candidate_id_idx ON public.meetings (candidate_id);
drop index if exists public.meetings_candidate_id_idx;

-- CREATE INDEX meetings_contact_id_idx ON public.meetings (contact_id);
drop index if exists public.meetings_contact_id_idx;

-- CREATE INDEX idx_subscriptions_free_month_code ON public.subscriptions (free_month_code);
drop index if exists public.idx_subscriptions_free_month_code;

-- CREATE INDEX idx_subscriptions_stripe_customer ON public.subscriptions (stripe_customer_id);
drop index if exists public.idx_subscriptions_stripe_customer;

-- CREATE INDEX support_messages_created_at_idx ON public.support_messages (created_at);
drop index if exists public.support_messages_created_at_idx;

-- CREATE INDEX support_messages_user_created_idx ON public.support_messages (user_id, created_at);
drop index if exists public.support_messages_user_created_idx;

-- CREATE INDEX support_messages_user_id_idx ON public.support_messages (user_id);
drop index if exists public.support_messages_user_id_idx;

-- CREATE INDEX teams_created_by_idx ON public.teams (created_by);
drop index if exists public.teams_created_by_idx;
