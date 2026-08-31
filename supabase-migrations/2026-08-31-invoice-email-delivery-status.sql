-- 2026-08-31: closes a real gap found while investigating a customer report
-- of an invoice email that never arrived. send-invoice.js only ever knew
-- "did Resend's API accept this send" — never whether the email actually
-- reached the inbox, bounced, or was flagged as spam. An invoice sat marked
-- 'sent' forever regardless of what actually happened after Resend accepted
-- it, with nobody — not the customer, not Annie — ever finding out.
--
-- resend_email_id is the id Resend's own API returns on a successful send
-- (previously captured, then discarded — see email.js's own header),
-- captured now so an incoming Resend delivery webhook can be matched back
-- to the right invoice. email_delivery_status starts null/'pending' the
-- moment an invoice is sent and is updated by resend-webhook.js as real
-- delivery events (delivered/bounced/complained/delayed) come in.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS resend_email_id text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS email_delivery_status text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS email_delivery_updated_at timestamptz;

-- Looked up by resend-webhook.js on every incoming event — one lookup per
-- webhook delivery, worth an index rather than a sequential scan of every
-- invoice ever sent.
CREATE INDEX IF NOT EXISTS invoices_resend_email_id_idx ON invoices (resend_email_id) WHERE resend_email_id IS NOT NULL;

-- Same idempotency pattern stripe-webhook.js already uses for
-- stripe_webhook_events (see that table's own history): Resend/Svix can and
-- does redeliver the same webhook event on a retry. event_id (Svix's own
-- delivery id, from the svix-id header) as the PRIMARY KEY means a
-- redelivered event hits a real unique-violation instead of a race or a
-- silent double-apply — reserved via a single INSERT before any handling
-- runs, same as the Stripe table.
CREATE TABLE IF NOT EXISTS resend_webhook_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
