# Annie E2E suite (test-payments branch deploy)

Real end-to-end tests against the live branch deploy at
`https://test-payments--annie-app.netlify.app`, backed by the real staging
Supabase project (`tqzafepeicfybxqysjjx`) and Stripe test mode. Nothing here
is mocked — every test drives the actual running app.

## Running it

```bash
# from the repo root
npm install -D @playwright/test --no-save   # already installed if node_modules is intact
npx playwright test --config=e2e/playwright.config.js
```

Useful variants:

```bash
# one file
npx playwright test --config=e2e/playwright.config.js e2e/tests/05-crm-crud.spec.js

# see the HTML report after a run (written to e2e/report/)
npx playwright show-report e2e/report
```

## Why the Chromium launch options look unusual

This container's outbound HTTPS is routed through a proxy via `HTTPS_PROXY`/
`https_proxy` env vars for most tools. Chromium auto-detects and uses those
on Linux, but the resulting TLS handshake to the real internet gets reset
(confirmed by direct reproduction — every navigation failed with
`net::ERR_CONNECTION_RESET`, including to unrelated sites like example.com).
`playwright.config.js` passes `--no-proxy-server --proxy-bypass-list=*
--ignore-certificate-errors` to force Chromium to connect directly instead,
which is what actually gave this suite real network access. If you run this
suite somewhere without that proxy setup, these flags are harmless no-ops.

## Accounts and data

- `e2e/fixtures/accounts.js` holds the three fixture accounts (owner,
  newuser, admin) and Stripe's published test card. These are real,
  persistent staging accounts — see the task brief for their exact state.
- Any new account this suite creates (checkout signups, team invites) uses
  a timestamp-suffixed unique email via `uniqueEmail()`, so reruns don't
  collide with a previous run's leftovers.
- Any CRM record created (Company/Contact/Job/Candidate/Deal) is prefixed
  `E2E-`/`E2E ` so it's identifiable in the shared staging data afterward.
  Cleanup is intentionally NOT automatic — see the task brief.

## Auth caching

`tests/global.setup.js` (the `setup` project) logs in as the owner and
admin fixtures once and caches each session's storageState under
`e2e/.auth/` (gitignored). Every other spec that needs to act "as the
owner" or "as the admin" declares `test.use({ storageState: OWNER_AUTH_FILE })`
(or `ADMIN_AUTH_FILE`) instead of repeating the login flow. Specs that
need a genuinely fresh login (the login-redirect test, the brand-new
onboarding wizard test, the two Stripe checkout signups) log in directly
instead, since a cached state wouldn't exercise what they're actually
testing.

## Known rerun caveat: team invites and seat limits

Scenario 11 (`11-team-invite.spec.js`) invites a fresh email to e2e-owner's
Team-tier (3-seat) plan every run, and nothing in this suite ever removes a
team_members row afterward. After two full suite runs the team will be at
3/3 seats (owner + 2 invited), and a third run's invite attempt will get a
real, correct `"Your plan includes 3 seats, all in use or invited"` error
from team-invite.js — that's expected backend behavior once seats run out,
not a bug in the suite or the app. Free seats via Billing's "Remove" button
on the owner's roster (or from Supabase directly) before rerunning if you
hit this.
