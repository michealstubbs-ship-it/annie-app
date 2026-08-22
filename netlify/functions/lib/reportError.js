// Best-effort write to public.error_logs so a failure in a Netlify function
// leaves a trace someone can actually find later, instead of only existing
// for a few days in Netlify's own function logs that nobody was watching.
// See supabase-migrations/2026-08-21-error-logs.sql for the table. Also the
// one choke point (2026-08-22) where every one of these errors now reaches
// Sentry too — see the Sentry block below — since every real call site
// already funnels through here, wiring it in once here covers all of them
// instead of touching 11 separate function files.
//
// Never allowed to affect the caller: reporting failures are swallowed
// exactly like every other fail-open guard in this codebase
// (reserveApolloCredits in scanShared.js is the same philosophy) — a broken
// error reporter must never turn one real error into a second, worse one.
import { createClient } from '@supabase/supabase-js'
import * as Sentry from '@sentry/node'

// Optional forever, same shape as Apollo/Companies House elsewhere — an
// unset SENTRY_DSN just means Sentry reporting is off, error_logs below
// still works on its own. Sentry.init is a global, one-time call, so it's
// guarded separately from the per-call try/catch below; a warm Netlify
// Function instance reuses this module (and this flag) across invocations,
// a cold one re-evaluates it once.
let sentryInitialized = false
function ensureSentryInit() {
  if (sentryInitialized) return
  sentryInitialized = true
  const dsn = process.env.SENTRY_DSN
  if (!dsn) return
  Sentry.init({
    dsn,
    // Netlify sets CONTEXT to production/deploy-preview/branch-deploy —
    // lets Sentry separate real production errors from preview noise.
    environment: process.env.CONTEXT || 'production',
    // Error tracking only, deliberately — no performance tracing/spans.
    // Keeps this within Sentry's error-only free-tier volume rather than
    // also metering every function call's latency, which nothing here
    // asked for or needs.
    tracesSampleRate: 0,
  })
}

// The 4th argument exists purely for tests to inject a mock client — every
// real call site omits it and gets a real one built from env vars.
export async function reportServerError(fnName, err, context = {}, injectedClient = null) {
  if (process.env.SENTRY_DSN) {
    try {
      ensureSentryInit()
      Sentry.captureException(err, { tags: { fn_name: fnName }, extra: context })
      // Netlify freezes the process the instant the handler's promise
      // resolves — without this, a batched/async Sentry event queued a
      // moment earlier can simply never be sent. flush() waits (briefly)
      // for the in-flight send instead of losing it to that freeze.
      await Sentry.flush(2000)
    } catch {
      // Sentry itself must never become a second failure — same rule as
      // the Supabase write below.
    }
  }

  try {
    let supabase = injectedClient
    if (!supabase) {
      const supabaseUrl = process.env.VITE_SUPABASE_URL
      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
      if (!supabaseUrl || !serviceKey) return
      supabase = createClient(supabaseUrl, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    }
    await supabase.from('error_logs').insert({
      source: 'function',
      fn_name: fnName,
      message: (err && err.message) || String(err),
      stack: err && err.stack ? String(err.stack) : null,
      context,
    })
  } catch {
    // Reporting the error must never throw — see file header.
  }
}
