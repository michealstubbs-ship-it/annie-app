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

`netlify.toml`'s build command is `npm test && npm run build` — a failing test stops the build before it ever reaches `vite build`, so a real regression can't reach production just because the frontend still compiles. Test coverage is concentrated in pure-logic library files, plus the highest-stakes HTTP handlers added during the 2026-08-22 scale-readiness pass (`stripe-webhook.js`, the only writer of `public.subscriptions`; `health.js`; `error-rate-monitor.js`). Most other Netlify function handlers (chat, onboarding, scans) are still untested and remain the next place to add coverage.

## Observability

`GET /api/health` (`netlify/functions/health.js`) is public, checks real Supabase connectivity, and returns 200/503 for an external uptime monitor to poll. `error-rate-monitor.js` runs hourly and posts to Slack (`SLACK_WEBHOOK_URL`, see `.env.example`) if `error_logs` sees a spike. Neither is a substitute for a real error tracker/APM (Sentry or similar) — see "Known gaps" below.

## Known gaps needing a decision, not silently implemented

A few findings from the 2026-08-22 audit need Michael's own account/cost decisions rather than being built quietly:

- **Bot protection** (CAPTCHA/Turnstile) on signup — needs a Cloudflare Turnstile or similar account.
- **A real error tracker/APM** (Sentry or similar) — `error-rate-monitor.js` is a stopgap, not a replacement; needs its own account.
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
  contexts/                AuthContext (the only global state today)

netlify/functions/         backend — one file per HTTP endpoint or scheduled/background job
  lib/                     shared backend logic (auth, env validation, Apollo/Anthropic
                          usage caps, error reporting, the scan pipeline's shared row-building)

supabase-migrations/        every schema change, timestamped, in order — see above
```
