-- Run this once in the Supabase SQL Editor, same as the other migration files.
--
-- Billing foundation. This table is the single source of truth in Annie's
-- own database for what a customer's subscription state is — the actual
-- billing relationship lives in Stripe, this is a synced read model kept up
-- to date by stripe-webhook.js so the app never has to call out to Stripe
-- just to know "is this customer active." One row per customer; a customer
-- with no row yet has never started a checkout.
--
-- Deliberately does NOT enforce access anywhere yet (no paywall reads this
-- table's status). Whether/how unpaid access is gated is a separate product
-- decision, not something to encode silently in a schema migration.

CREATE TABLE IF NOT EXISTS public.subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_customer_id text UNIQUE,
  stripe_subscription_id text UNIQUE,
  -- Mirrors the tier names in src/pages/Billing.jsx / the price-ID env vars
  -- read by stripe-checkout.js. Kept as free text rather than an enum so a
  -- new tier doesn't require a migration to add.
  tier text,
  -- Mirrors Stripe's own subscription status strings directly (trialing,
  -- active, past_due, canceled, unpaid, incomplete, incomplete_expired) —
  -- no local re-mapping, so this never drifts out of sync with what Stripe
  -- actually reports.
  status text NOT NULL DEFAULT 'none',
  billing_interval text CHECK (billing_interval IN ('month', 'year')),
  seats integer NOT NULL DEFAULT 1,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_customer ON public.subscriptions(stripe_customer_id);

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

-- A customer can read their own billing status (to render the Billing page)
-- but never write it directly — every write goes through stripe-webhook.js
-- using the service role, driven only by real events Stripe sends, never by
-- a client-side update a customer could spoof to grant themselves a paid
-- tier for free.
CREATE POLICY "Own subscription read-only" ON public.subscriptions
  FOR SELECT USING (auth.uid() = user_id);
