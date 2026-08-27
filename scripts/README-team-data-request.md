# Handling a "delete my account" / "export my data" request

Settings.jsx's "Request data export" and "Request account deletion" buttons
file a row in `account_requests` — nothing happens automatically after that.
This is the manual process for actually acting on one of those requests.

## 1. Find the request

Pending requests are visible via the admin `get_account_requests()` RPC (the
same one the admin dashboard's Insights/requests view already calls). Each
row has the requesting user's `id` and `email`, plus `request_type`
(`'export'` or `'delete'`).

## 2. Run a dry-run first, always

```
VITE_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
  node scripts/team-data-request.mjs --user-id=<the requester's id>
```

(`--mode=dry-run` is the default, so it's safe to omit — this never writes
anything.) This resolves the user to their team, prints the team name and
every member, and prints a row count per table. Read this output before
doing anything else — in particular, check the member count. A request from
one person on a multi-person team is very likely NOT a request to delete the
whole team; that's a job for the "remove teammate" flow in-app instead
(`team-remove-member.js`), not this script.

## 3. For an export request

```
VITE_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
  node scripts/team-data-request.mjs --user-id=<id> --mode=export --out=export.json
```

Send `export.json` to the requester over whatever channel you'd trust with
their own business data (it contains real customer/candidate PII), then
delete your local copy.

## 4. For a deletion request

Take the resolved team id from the dry-run output in step 2, then:

```
VITE_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... STRIPE_SECRET_KEY=... \
  node scripts/team-data-request.mjs --team-id=<resolved team id> --mode=delete --confirm=<same team id>
```

`--confirm` has to repeat the exact same id as `--team-id` — this is a
deliberate "type it twice" guard against running delete against the wrong
id from a copy-paste slip. The script runs its own fresh dry-run pass and
prints it before doing anything, then waits 5 seconds (Ctrl+C to abort)
before it starts deleting. If a step fails partway through, it stops
immediately and tells you exactly what's already gone and what isn't — the
whole thing is safe to re-run, every delete is idempotent.

Include `STRIPE_SECRET_KEY` if the team has a real paid subscription — the
script cancels it in Stripe before touching Supabase, so the customer's card
never gets charged again for an account that no longer exists. If you leave
it out, the script tells you so explicitly rather than silently skipping it.

## What this does NOT touch

`company_contacts` and `company_enrichment` — shared, Apollo/TheirStack-
sourced company and contact data cached across every customer, not this
team's own data. Deleting a team never touches these.

## This is a stopgap, not the final answer

This exists because, as of the 2026-08-26 audit, there was no working path
at all — the buttons in Settings filed a ticket nobody ever acted on, and a
manual `deleteUser` call would have silently orphaned data with no error
(no table in this schema actually has a foreign key constraint back to
`auth.users`, confirmed directly against production). A documented manual
process is the right amount of engineering for where the product is today
(pre-launch, no real requests yet) — a self-serve, automated version is
worth building once real request volume shows it's needed, not before.
