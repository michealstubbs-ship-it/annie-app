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

`netlify.toml`'s build command is `npm test && npm run build` — a failing test stops the build before it ever reaches `vite build`, so a real regression can't reach production just because the frontend still compiles. Test coverage is concentrated in pure-logic library files, plus the highest-stakes HTTP handlers added or covered during the 2026-08-22 scale-readiness pass (`stripe-webhook.js`, the only writer of `public.subscriptions`; `health.js`; `error-rate-monitor.js`; `data-retention.js`; `chat.js`'s auth/rate-limit/cost-cap/error-handling branches; `verify-turnstile.js`). Most other Netlify function handlers (onboarding, scans, the remaining billing endpoints) are still untested and remain the next place to add coverage.

## Observability

`GET /api/health` (`netlify/functions/health.js`) is public, checks real Supabase connectivity, and returns 200/503 for an external uptime monitor to poll. `error-rate-monitor.js` runs hourly and posts to Slack (`SLACK_WEBHOOK_URL`, see `.env.example`) if `error_logs` sees a spike. Real error tracking — stack traces, history, grouping — is Sentry, wired in via `reportError.js`; see "Error tracking" below.

## API response conventions

Every Netlify function returns JSON with a `Content-Type: application/json` header, via the shared `jsonError(status, message, extra)` helper in `netlify/functions/lib/httpError.js` (`{ error: message, ...extra }` at the given status). Two functions still return plain text by design, not by oversight: `stripe-webhook.js` (Stripe is its only caller — a webhook, not the frontend) and `intelligence-scan.js`'s cron-only responses. Both were deliberately left alone during the 2026-08-22 consistency pass to avoid touching live, billing-critical code for a purely cosmetic gain.

"Not configured" (a required env var is missing) is reported with different status codes on purpose, not inconsistently — pick based on what's actually true about that endpoint:

- **500** — `chat.js`, `save-onboarding.js`, `verify-turnstile.js`. These should always be configured in any real deployment, so a missing var is a genuine server misconfiguration.
- **503** — `stripe-checkout.js`, `stripe-portal.js`. Billing keys only exist once Stripe setup is complete, so an unset var means "not available right now," which is what 503 signals to a caller, rather than 500's "something is broken."
- **200 with `{ configured: false }`** — `apollo-enrich-companies.js`. Apollo is optional forever — Annie falls back to a keyword heuristic when it isn't set up — so a missing key isn't an error at all, and returning a 4xx/5xx here would make the frontend show an error banner for expected, graceful degradation.

When a new endpoint gates on optional configuration, ask the same question: required in every real deployment (500), optional but blocking one feature until set up (503), or optional forever with a working fallback (200 + a `configured` flag)?

## Bot protection

Signup is gated by Cloudflare Turnstile: `src/components/Turnstile.jsx` renders the widget, and `netlify/functions/verify-turnstile.js` checks the resulting token against Cloudflare's `siteverify` API server-side before `Login.jsx` calls `supabase.auth.signUp` — the client-side widget alone proves nothing, since anyone can skip calling it. Optional in the sense that it degrades gracefully: unset `VITE_TURNSTILE_SITE_KEY`/`TURNSTILE_SECRET_KEY` and the widget doesn't render and verification is skipped entirely, exactly like Apollo's optional-forever pattern above — useful for local dev without a Turnstile account.

## Error tracking

`netlify/functions/lib/reportError.js` is the one place every function already funnels its errors through (11 of the 14 functions call it), so it's the one place Sentry needed wiring in — `reportServerError` now calls `Sentry.captureException` alongside its existing `error_logs` write, tagged with the function name and whatever context that call site passed. Error tracking only (`tracesSampleRate: 0`) — no performance tracing/spans, since nothing here asked for that and it would meter volume this app doesn't need. `error-rate-monitor.js`'s hourly Slack alert stays as-is; Sentry is the actual tool for digging into a specific error's stack trace and history, the Slack alert is just the "something's wrong, go look" trigger. Optional forever like everything else in this section: unset `SENTRY_DSN` and `error_logs` keeps working exactly as before, just without also reaching Sentry.

## Known gaps needing a decision, not silently implemented

A few findings from the 2026-08-22 audit need Michael's own account/cost decisions rather than being built quietly:

- **A second Supabase project for real staging isolation** — a recurring cost, see "Deploying" above.
- **Supabase CLI migration tooling** — needs an actual git repo to drive it; see "Database schema & migrations" above.

## Database schema & migrations

Every schema change lives as a plain, timestamped `.sql` file in `supabase-migrations/` — applied directly against the live Supabase project (via the Supabase MCP or the SQL Editor), then committed here for the record. Each file's header comment explains what it does and why. To set up a fresh environment, run every file in `supabase-migrations/` in filename order — they're all written to be safe to re-run (`if not exists`, `create or replace`).

This is a deliberate, audited tradeoff, not an oversight: there's no Supabase CLI migration history or connected git repo driving deploys in this project today. If/when this codebase moves to a real git-tracked repo, adopting the Supabase CLI's own migration format (`supabase db push`) is the natural next step — it gives machine-enforced ordering and history instead of "run these files in order by hand."

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
                          candidates.js, companies.js, jobs.js) — every raw
                          query for that table, so a schema change touches
                          one file instead of every component that reads or
                          writes it. Pairs with useSupabaseQuery.js, which
                          owns the loading/error/refetch lifecycle around
                          whatever fetcher a page passes it. Contacts,
                          Candidates, and Companies are migrated onto this;
                          the rest of the list pages (Jobs, Meetings,
                          Pipeline, Tasks, IntelligenceFeed) still fetch
                          inline and are the next candidates.
  contexts/                AuthContext (the only global state today)

netlify/functions/         backend — one file per HTTP endpoint or scheduled/background job
                          (verify-turnstile.js checks a signup's Turnstile token
                          server-side — see "Bot protection" above)
  lib/                     shared backend logic (auth, env validation, Apollo/Anthropic
                          usage caps, error reporting, the scan pipeline's shared row-building)

supabase-migrations/        every schema change, timestamped, in order — see above
```
