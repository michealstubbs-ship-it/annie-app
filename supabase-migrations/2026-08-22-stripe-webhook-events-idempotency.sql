-- Makes stripe-webhook.js idempotent against Stripe's own event redelivery
-- (network retries, manual resends from the dashboard) — previously only
-- the subscriptions writes themselves were idempotent-safe (via onConflict);
-- invoice.payment_failed's email send was not, so a redelivered event could
-- re-send "your payment failed" to a customer who already got it once.
--
-- The webhook handler checks this table before processing an event and
-- records event.id only after successfully processing it (never in the
-- error path — a genuine failure still returns 500 so Stripe actually
-- retries, per 2026-08-22's other stripe-webhook.js fix).
--
-- Applied directly to the live DB via the Supabase MCP on 2026-08-22 (named
-- `stripe_webhook_events_idempotency`). Run this once in the Supabase SQL
-- Editor if setting up a fresh environment.
create table if not exists public.stripe_webhook_events (
  event_id text primary key,
  event_type text,
  processed_at timestamptz not null default now()
);

alter table public.stripe_webhook_events enable row level security;
-- No policies granted on purpose, same convention as apollo_usage: only the
-- service role (which bypasses RLS entirely) ever reads or writes this
-- table, always from stripe-webhook.js server-side.
