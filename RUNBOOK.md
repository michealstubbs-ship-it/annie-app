# Incident & recovery runbook

Written after a scale-readiness audit (2026-08-22) found no recovery process documented anywhere. This is a starting point, not a substitute for a real incident-response plan once the team grows.

## Data loss / bad migration recovery

Annie's Supabase project is on the Pro plan, which includes automated daily backups. **Confirm point-in-time recovery (PITR) is enabled** in the Supabase dashboard (Settings → Backups) before relying on this section — it wasn't confirmed either way as of this writing, and PITR is what lets you restore to a specific moment (right before a bad migration or accidental delete) rather than only to last night's snapshot.

1. **Stop the bleeding first.** If a bad migration or script is actively running, revoke its access or disable the function/scheduled job responsible before restoring — otherwise the restore just gets overwritten again.
2. **In the Supabase dashboard**: Settings → Backups → choose a restore point. A PITR restore lets you pick a specific timestamp; a daily backup restore is limited to that day's snapshot.
3. **Restoring creates a new database** — it does not overwrite the live one in place. After restoring, you'll need to point the app at the restored database (update `VITE_SUPABASE_URL`/keys) or manually reconcile the difference, depending on how much time has passed since the incident.
4. **Communicate the data-loss window to affected customers** honestly — what time range is affected, what they should re-check.

## Recurring scan not running / signals not appearing

`intelligence-scan.js` runs every 12 hours as a scheduled Netlify function. If customers report no new signals:

1. Check Netlify's function logs for `intelligence-scan` — look for the `⚠️ intelligence-scan: 0 new signals` alert (goes to Slack if `SLACK_WEBHOOK_URL` is configured) or a `time budget reached` log line (means it didn't get through every customer this run — see the comment in `intelligence-scan.js` on `RUN_BUDGET_MS`).
2. Check `error_logs` (via the admin Insights page, or directly in Supabase) filtered to `source ilike '%intelligence-scan%'`.
3. Common causes: a suspended/expired `ANTHROPIC_API_KEY`, `APOLLO_API_KEY`, or `COMPANIES_HOUSE_API_KEY`; the Anthropic daily token cap or Apollo daily credit cap being hit (check `anthropic_usage`/`apollo_usage` tables); a provider outage.

## Billing / subscription state out of sync

`stripe-webhook.js` is the only writer of `public.subscriptions`. If a customer's plan looks wrong in the app:

1. Check `stripe_webhook_events` for the relevant `event_id` (visible in the Stripe dashboard's event log) — if it's not there, the webhook never successfully processed that event.
2. Check `error_logs` for `source = 'stripe-webhook'` around the time of the event.
3. As of 2026-08-22, a failed webhook handler returns a real error status so Stripe retries automatically (its own retry schedule spans several days) — most transient failures self-heal without intervention. If Stripe's retry window has already lapsed, manually resend the event from the Stripe dashboard's event log, which will hit this same webhook.

## Data retention

`data-retention.js` runs weekly (Sundays, background function) and deletes rows older than ~18 months from `intelligence_signals`, `chat_messages`, `support_messages`, and `error_logs`, via four batched SQL functions (see `supabase-migrations/2026-08-22-data-retention.sql`). Deleting an old `intelligence_signals` row detaches (not deletes) any `signal_outcomes` row that pointed at it — the placement/outcome history survives, just unlinked from the aged-out signal. Check Netlify's function logs for `[data-retention]` if a customer says old data disappeared unexpectedly, or if `SLACK_WEBHOOK_URL` is configured, a failed run alerts there.

## Checking if the app is up

`GET /api/health` (backed by `netlify/functions/health.js`) is public and checks real Supabase connectivity — point an external uptime monitor (see README.md) at it. It returns `{"status":"ok","checks":{"database":"ok"}}` with a 200, or a 503 with `"status":"degraded"` if the database round-trip fails. `error-rate-monitor.js` runs hourly and posts to Slack (via `SLACK_WEBHOOK_URL`) if `error_logs` sees 20+ new rows in an hour — check that table directly (or the admin Insights page) for what's actually failing once alerted.

## Who has access

Document here once the team grows past one person: who holds the Supabase project owner role, who has Netlify site admin access, who has Stripe dashboard access, and who to page for each of the above.
