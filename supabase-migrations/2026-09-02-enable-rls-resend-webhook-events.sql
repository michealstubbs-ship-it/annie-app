-- Enables RLS on resend_webhook_events, which had none (Supabase security
-- advisor flag). No policies are added: this table is only ever written by
-- the Resend webhook handler using the service_role key, which bypasses RLS
-- entirely, matching the existing convention used by other webhook/ingest
-- tables in this schema (e.g. stripe_webhook_events).
-- Applied directly to production via Supabase MCP on 2026-09-02.

alter table public.resend_webhook_events enable row level security;
