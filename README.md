# Annie

Business-development intelligence for recruitment firms. Annie watches a firm's chosen sectors, functions, and locations, surfaces real signals (funding rounds, leadership changes, hiring activity, live job openings), verifies a contact where possible, and drafts a ready-to-send opening message — live at [app.meetannie.ai](https://app.meetannie.ai).

## Stack

- **Frontend**: React + Vite, deployed as a static site
- **Backend**: Netlify Functions (Node 22) — scheduled, background, and request-triggered
- **Database**: Supabase (Postgres + Auth + Row-Level Security + Storage)
- **AI research**: Anthropic (Claude, with web search)
- **Enrichment**: Apollo.io (company/contact data), Companies House (UK company verification), Adzuna (job postings)
- **Billing**: Stripe (Checkout + Billing Portal — Annie never touches a card number directly)

## Local development

```bash
npm install
cp .env.example .env.local   # fill in the values you need — see .env.example for what each does
npm run dev                  # starts the Vite dev server
```

The frontend alone (`npm run dev`) is enough for most UI work. To exercise the Netlify Functions locally too (chat, scans, billing, onboarding), use the [Netlify CLI](https://docs.netlify.com/cli/get-started/): `netlify dev` instead of `npm run dev`, with the server-side env vars from `.env.example` also set (via `netlify env:set` or a `.env` the CLI picks up).

## Testing & building

```bash
npm test          # vitest — pure-logic library files (src/lib, netlify/functions/lib)
npm run build     # vite build — also what Netlify runs on every deploy
```

`netlify.toml`'s build command is `npm test && npm run build` — a failing test stops the build before it ever reaches `vite build`, so a real regression can't reach production just because the frontend still compiles. Test coverage spans pure-logic library files (`src/lib`, `netlify/functions/lib`) and every Netlify function handler: the highest-stakes ones covered during the 2026-08-22 scale-readiness pass (`stripe-webhook.js`, the only writer of `public.subscriptions`; `health.js`; `error-rate-monitor.js`; `data-retention.js`; `chat.js`'s auth/rate-limit/cost-cap/error-handling branches; `verify-turnstile.js`), plus the remaining eight added in this pass: `scan-now-background.js`, `intelligence-scan.js`, `confirm-contact.js`, `scan-status.js`, `stripe-portal.js`, `stripe-checkout.js`, `apollo-enrich-companies.js`, and `save-onboarding.js`. Every Netlify function in the app now has at least a method/auth/config-guard test alongside its core logic paths.

## Observability

`GET /api/health` (`netlify/functions/health.js`) is public, checks real Supabase connectivity, and returns 200/503 for an external uptime monitor to poll. `error-rate-monitor.js` runs hourly and posts to Slack (`SLACK_WEBHOOK_URL`, see `.env.example`) if `error_logs` sees a spike. Real error tracking — stack traces, history, grouping — is Sentry, wired in via `reportError.js`; see "Error tracking" below.

## API response conventions

Every Netlify function returns JSON with a `Content-Type: application/json` header, via the shared `jsonError(status, message, extra)` helper in `netlify/functions/lib/httpError.js` (`{ error: message, ...extra }` at the given status). Two functions still return plain text by design, not by oversight: `stripe-webhook.js` (Stripe is its only caller — a webhook, not the frontend) and `intelligence-scan.js`'s cron-only responses. Both were deliberately left alone during the 2026-08-22 consistency pass to avoid touching live, billing-critical code for a purely cosmetic gain.

"Not configured" (a required env var is missing) is reported with different status codes on purpose, not inconsistently — pick based on what's actually true about that endpoint:

- **500** — `chat.js`, `save-onboarding.js`, `verify-turnstile.js`. These should always be configured in any real deployment, so a missing var is a genuine server misconfiguration.
- **503** — `stripe-checkout.js`, `stripe-portal.js`. Billing keys only exist once Stripe setup is complete, so an unset var means "not available right now," which is what 503 signals to a caller, rather than 500's "something is broken."
- **200 with `{ configured: false }`** — `apollo-enrich-companies.js`. Apollo is optional forever — Annie falls back to a keyword heuristic when it isn't set up — so a missing key isn't an error at all, and returning a 4xx/5xx here would make the frontend show an error banner for expected, graceful degradation.

When a new endpoint gates on optional configuration, ask the same question: required in every real deployment (500), optional but blocking one feature until set up (503), or optional forever with a working fallback (200 + a `configured` flag)?

## Mailbox sweep — 18 months, metadata only, zero AI

When a recruiter connects a mailbox, `email-sync-background.js` sweeps the last 18 months of it and files the people they actually deal with. Two properties of that sweep are load-bearing and easy to break by accident, so they are worth stating here as well as in the files:

**It costs no AI tokens.** The sweep runs `meta_only=true` at `limit=250` — no message bodies come back, so there is nothing for the note writer to summarise and no Anthropic call is possible on that data. The design it replaced fetched bodies and called `writeNote()` per matched message, which extended to 18 months is on the order of ten thousand model calls per signup. Notes stay **forward-only**: mail arriving from now on still gets its note through `email-webhook.js` exactly as before, and the backfill writes none, ever. `mailboxSweep.js` and `mailboxSweepApply.js` import neither `emailNote.js` nor `aiUsage.js`, and `mailboxSweep.test.js` asserts that over the transitive import graph rather than trusting it.

**A person becomes a contact only if the conversation went both ways.** They were written to *and* they wrote back, inside the window. One-way mail is newsletters, blasts, suppliers and no-reply addresses; a reply is a human choosing to answer, and it needs no model to read. An out-of-office or a bounce is explicitly *not* a reply (`email_interactions.auto_replies` counts them separately). Free-mail addresses — gmail, hotmail, yahoo, outlook.com, icloud — are never promoted even when they pass the test, because they carry no company for Annie to watch; they are kept as background data and counted in `email_accounts.sweep_stats.freeMailTwoWay`, which the Settings → Email panel shows. Everything held back stays in `email_interactions` and is never written into `contacts` or `candidates`.

Dedupe against an already-imported CRM goes through `matchContact()` — email first, then name + company — so the sweep enriches the row the LinkedIn import made instead of creating a second one. Promoted people get real interaction history on the contact (`first_exchange_at`, `last_exchange_at`, `messages_sent`, `messages_received`) and `relationship_tier = 'client'` via `deriveRelationshipTier({ hasTwoWayHistory: true })` — the first thing in the codebase able to pass that argument truthfully.

The sweep is **resumable**: the phase (`sweep_role`), the page cursor (`backfill_cursor`) and the pinned window (`sweep_after`) are written to `email_accounts` after every page, and an unfinished run re-invokes the function for that account. A 15-minute background function therefore completes a large mailbox across several runs instead of silently truncating. Schema: `supabase/migrations/20260905210000_mailbox_sweep.sql`.

## Bot protection

Signup is gated by Cloudflare Turnstile: `src/components/Turnstile.jsx` renders the widget, and `netlify/functions/verify-turnstile.js` checks the resulting token against Cloudflare's `siteverify` API server-side before `Login.jsx` calls `supabase.auth.signUp` — the client-side widget alone proves nothing, since anyone can skip calling it. Optional in the sense that it degrades gracefully: unset `VITE_TURNSTILE_SITE_KEY`/`TURNSTILE_SECRET_KEY` and the widget doesn't render and verification is skipped entirely, exactly like Apollo's optional-forever pattern above — useful for local dev without a Turnstile account.

## Error tracking

`netlify/functions/lib/reportError.js` is the one place every function already funnels its errors through (11 of the 14 functions call it), so it's the one place Sentry needed wiring in — `reportServerError` now calls `Sentry.captureException` alongside its existing `error_logs` write, tagged with the function name and whatever context that call site passed. Error tracking only (`tracesSampleRate: 0`) — no performance tracing/spans, since nothing here asked for that and it would meter volume this app doesn't need. `error-rate-monitor.js`'s hourly Slack alert stays as-is; Sentry is the actual tool for digging into a specific error's stack trace and history, the Slack alert is just the "something's wrong, go look" trigger. Optional forever like everything else in this section: unset `SENTRY_DSN` and `error_logs` keeps working exactly as before, just without also reaching Sentry.

## Known gaps needing a decision, not silently implemented

A finding from the 2026-08-22 audit needs Michael's own account/cost decision rather than being built quietly:

- **A second Supabase project for real staging isolation** — a recurring cost, see "Deploying" above.

## Database schema & migrations

The project is now wired for the Supabase CLI's own migration tooling (`supabase/config.toml`, `supabase/migrations/`), now that there's a real git repo to drive it from — the blocker noted in earlier versions of this doc is resolved. The Supabase project's migration history (`supabase_migrations.schema_migrations`) already goes back to project creation (2026-08-19): every schema change made through the Supabase MCP's `apply_migration` tool registers there automatically, CLI-compatible, whether or not this repo existed at the time.

**One-time setup**, from a machine with a browser (this can't be done headlessly):

```bash
npm run db:login             # opens a browser to authenticate the CLI against your Supabase account
npm run db:link              # links this repo to the annie-app project (tsnthomwislodczhshpt)
npm run db:repair-baseline   # see note below — needed once
npm run db:dump-baseline     # writes today's live schema as one baseline migration file
npm run db:mark-baseline-applied  # registers that file as the new applied history — no drift
```

`db:repair-baseline` exists because the project's migration history already went back to 2026-08-19 (every schema change made through a Claude session registers there automatically) before this local CLI setup existed — so there's history with no matching local file. It marks those 39 pre-CLI entries as `reverted` in Supabase's own bookkeeping table only; it runs no SQL against your actual schema and changes no data. That clears the way for a fresh baseline to become the new starting point.

`db:dump-baseline` + `db:mark-baseline-applied` do together what Supabase's own docs describe as a single `supabase db pull` — but `db pull` additionally spins up a temporary local "shadow" Postgres via Docker to compute its diff, so it hard-requires Docker Desktop to be installed and running. Rather than adding a Docker Desktop install as a prerequisite for a one-time setup step, `db dump --linked` does the equivalent job with a direct `pg_dump` against the live project (no Docker needed), and `migration repair --status applied` does what `db pull` would otherwise register automatically. If Docker Desktop is ever installed later, `npm run db:pull` (already wired up) works too and is the more idiomatic path for anyone following Supabase's own docs from scratch.

After `db:dump-baseline` finishes, skim the generated `supabase/migrations/20260822135842_remote_schema.sql` before committing — a raw `pg_dump` occasionally includes a stray statement like `SET` session config lines or role ownership statements that don't matter for a from-scratch restore; safe to leave as-is unless something looks clearly wrong.

**Day to day, going forward**, either of these works and both write to the same shared history table, so they interoperate cleanly:

- From a Claude session: ask for the schema change — it goes through the Supabase MCP's `apply_migration`, same as always.
- From the CLI directly: `npm run db:new <name>` to scaffold a timestamped file in `supabase/migrations/`, write the SQL, then `npm run db:push` to apply it and commit the file.

`supabase-migrations/` (no CLI involved, plain `.sql` files) is the pre-CLI historical record of the 2026-08-21/22 audit's own schema work — kept as-is for that record, not added to going forward. Every file in it was already applied via `apply_migration` at the time, so it's already captured in the CLI-tracked history above; nothing there needs replaying.

## Environment variables

See `.env.example` for the full list with explanations — it's kept as the single source of truth, including which server-side vars are optional and what happens if you leave them unset (Annie degrades gracefully rather than crashing: no Stripe key means billing is disabled but everything else works, no Companies House key means scans run without that corroboration, etc.).

## Deploying

Deploys go straight to the site's Netlify project. There is currently one production Supabase project and one production Netlify site — `netlify.toml` has `[context.deploy-preview]`/`[context.branch-deploy]` blocks wired up, but they only give real staging isolation once separate, staging-scoped environment variables (a second Supabase project, Stripe test-mode keys) are set for those contexts in the Netlify UI.

## Repo layout

```
src/                      React frontend
  components/             page-level and shared UI components
  pages/                  top-level routed pages (Login, Onboarding, Dashboard, ...)
  lib/                    logic shared across components — also imported by
                          netlify/functions/lib for the pieces genuinely
                          shared between frontend and backend (see the
                          comments in scanShared.js for which and why)
    data/                  one file per Supabase table (contacts.js,
                          candidates.js, companies.js, jobs.js, meetings.js,
                          deals.js, tasks.js, signals.js, onboarding.js) —
                          every raw query for that table, so a schema change
                          touches one file instead of every component that
                          reads or writes it. Pairs with useSupabaseQuery.js,
                          which owns the loading/error/refetch lifecycle
                          around whatever fetcher a page passes it. Every
                          list page (Contacts, Candidates, Companies, Jobs,
                          Meetings, Pipeline, Tasks, IntelligenceFeed) is
                          migrated onto this — none fetch from Supabase
                          inline anymore.
  contexts/                AuthContext (the only global state today)

netlify/functions/         backend — one file per HTTP endpoint or scheduled/background job
                          (verify-turnstile.js checks a signup's Turnstile token
                          server-side — see "Bot protection" above)
  lib/                     shared backend logic (auth, env validation, Apollo/Anthropic
                          usage caps, error reporting, the scan pipeline's shared row-building)

supabase-migrations/        pre-CLI historical record of the 2026-08-21/22 audit's
                          schema work — see "Database schema & migrations" above
supabase/                  Supabase CLI project files — config.toml, migrations/
                          (populated by `npm run db:pull` after one-time setup)
```
