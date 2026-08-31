// Netlify's `schedule` trigger for the twice-daily customer scan. This file
// does none of the actual research work itself — its only job is to be the
// thing Netlify's scheduler can invoke on a cron (only a plain `schedule`
// export gets that), and to immediately fire intelligence-scan-background.js
// over HTTP, which does the real per-customer research loop with the long
// execution budget that work actually needs.
//
// 2026-08-31 root-cause fix for "no signals for 46 hours, across every
// customer, with nothing in the logs" (Michael, live on his own trial
// account): this used to be ONE function trying to be both a `schedule`
// trigger AND the long-running worker itself, via
// `export const config = { schedule: '0 */12 * * *', background: true }`.
// That combination was never actually a documented or reliably-supported
// Netlify pattern — checked directly against Netlify's own docs and support
// forum (31 Aug 2026): `background: true` as a config property is
// documented for HTTP-invoked functions (a request gets an immediate 202
// while work continues after responding), never confirmed to also extend a
// *scheduled* invocation's execution budget — and a Netlify staff reply on
// exactly this question ("Can background functions be scheduled?") points
// at a different, two-function pattern as the one that actually works,
// while a real user report in the same thread describes a scheduled
// function with the `-background` suffix alone still getting killed at the
// short scheduled-function limit in practice. A killed invocation doesn't
// throw into a try/catch or reach reportServerError — it just stops
// existing mid-run, which is exactly why 46 hours of failures produced zero
// entries in error_logs: the previous fix (22 Aug) correctly diagnosed the
// 30-second cap as the problem, it just didn't actually solve it.
//
// The one combination Netlify staff confirm actually works — and that this
// exact codebase already proves out in production, not a new pattern: every
// real "Scan Now" click and onboarding's first scan already goes through
// scan-now-background.js successfully, a function invoked over plain HTTP
// and named with the `-background` suffix, no `schedule` in sight. This
// file is the schedule-side half of that same shape: stay alive just long
// enough to fire one request at intelligence-scan-background.js's URL, well
// inside the 30-second scheduled-function limit, and let THAT function carry
// the actual 15-minute budget. Auth between the two is the same
// INTERNAL_SCAN_SECRET / x-internal-scan-secret shared-secret header
// scan-now-background.js's own internal chaining (round 2+) already uses —
// no new secret to configure, it's already set in Netlify.
import { reportServerError } from './lib/reportError.js'

const INTERNAL_SCAN_SECRET = process.env.INTERNAL_SCAN_SECRET

// Same retry-once-then-report shape as scan-now-background.js's own
// fireNextRound, exported for the same reason: testable directly against a
// mocked global.fetch without dragging the whole research pipeline
// (scanShared.js's own tested territory) into this file's tests.
export function fireBackgroundScan() {
  if (!INTERNAL_SCAN_SECRET) {
    const msg = 'INTERNAL_SCAN_SECRET not configured — cannot fire intelligence-scan-background (no customers get scanned this cycle)'
    console.error('[intelligence-scan]', msg)
    return reportServerError('intelligence-scan', new Error(msg), { stage: 'trigger-fire' })
  }
  const baseUrl = process.env.URL || process.env.DEPLOY_PRIME_URL
  if (!baseUrl) {
    const msg = 'no site URL available to fire intelligence-scan-background'
    console.error('[intelligence-scan]', msg)
    return reportServerError('intelligence-scan', new Error(msg), { stage: 'trigger-fire' })
  }

  const attemptFire = () => fetch(`${baseUrl}/.netlify/functions/intelligence-scan-background`, {
    method: 'POST',
    headers: { 'x-internal-scan-secret': INTERNAL_SCAN_SECRET },
  })

  return attemptFire().then(resp => {
    if (resp.ok) return
    const msg = `intelligence-scan-background fire got HTTP ${resp.status} — retrying once`
    console.error('[intelligence-scan]', msg)
    return attemptFire().then(retryResp => {
      if (retryResp.ok) return
      const retryMsg = `intelligence-scan-background fire got HTTP ${retryResp.status} on retry — giving up this cycle (next scheduled run is in ~12 hours)`
      console.error('[intelligence-scan]', retryMsg)
      return reportServerError('intelligence-scan', new Error(retryMsg), { stage: 'trigger-fire' })
    })
  }).catch(err => {
    console.error('[intelligence-scan] failed to fire background scan:', err.message)
    return reportServerError('intelligence-scan', err, { stage: 'trigger-fire' })
  })
}

// Netlify does not let scheduled functions (the `config = { schedule }`
// export below) be invoked by direct URL at all — checked directly against
// the live deploy (21 Aug 2026, re-confirmed 31 Aug 2026): both a curl and a
// POST to this function's own URL return 403 from Netlify's own edge,
// before this code ever runs. That protection is exactly as good as it
// always was, since this file still only ever exports `schedule`, never
// `path`. intelligence-scan-background.js is the one that's now directly
// URL-reachable (that's the whole point — this file invokes it over HTTP)
// and carries its own x-internal-scan-secret check accordingly; don't
// assume this file's schedule-only protection extends to it.
//
// The method check below is just hygiene (Netlify's scheduler always POSTs)
// — it isn't what's actually keeping this safe.
export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }
  await fireBackgroundScan()
  return new Response('Scan triggered', { status: 200 })
}

export const config = { schedule: '0 */12 * * *' }
