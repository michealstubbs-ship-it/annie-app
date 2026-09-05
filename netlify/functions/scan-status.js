// Lets the dashboard ask "is my post-onboarding research scan still
// running, or did it finish, and what actually happened?" instead of just
// guessing off a fixed timer. A fast, cheap, synchronous read of the status
// blob that scan-now-background.js writes — this function does no research
// itself, no Anthropic/Apollo calls, just a lookup.
import { getStore } from '@netlify/blobs'
import { reportServerError } from './lib/reportError.js'
import { getAuthedUser } from './lib/auth.js'
import { SCAN_TIER_CONFIG } from './lib/entitlements.js'
import { canonicalTier } from '../../src/lib/pricing.js'

export default async (req) => {
  const unknown = () => new Response(JSON.stringify({ status: 'unknown' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY

  const { user, error } = await getAuthedUser(req, supabaseUrl, anonKey)
  if (error) return unknown()

  try {
    const store = getStore({ name: 'annie-scan-status', consistency: 'strong' })
    const record = await store.get(user.id, { type: 'json' })

    // scan-now-background.js can now chain across several invocations
    // (2026-08-25 — see that file's own header), each with its own 15-
    // minute Netlify budget, so `startedAt` on the blob is the whole
    // CHAIN's start, not one invocation's. If a chain gets hard-killed
    // mid-run (a hung external call, an unhandled error, or the internal
    // continuation call itself failing to fire), it can leave the status
    // blob stuck on "running" forever, with no terminal status ever
    // written — which otherwise means the dashboard's "Annie is
    // researching" state never resolves. Treat a "running" status older
    // than that account's own tier ceiling (plus a margin for the final
    // round's own processing time) as timed out rather than trusting it
    // verbatim — using the tier-specific ceiling here, not a flat number,
    // is what stops this from flagging a legitimately still-chaining
    // Growth/Team scan as dead partway through its longer allowance.
    if (record?.status === 'running' && record?.startedAt) {
      // 2026-08-26 audit fix: the fallback for a missing/unrecognized tier used
      // to be a separately hardcoded `10 * 60 * 1000` — it happened to equal the
      // default tier's own maxWallClockMs, but nothing kept them in sync.
      // References the real config value instead.
      //
      // 2026-09-05: canonicalTier so a record stamped with a retired tier key resolves to
      // its real ceiling rather than falling through to the default. The
      // fallback is Solo because Starter no longer exists — reading
      // SCAN_TIER_CONFIG.starter here threw once the tier was removed, and the
      // handler answered "unknown" for every scan, which looks exactly like a
      // scan that never ran.
      const tierCeilingMs = SCAN_TIER_CONFIG[canonicalTier(record.tier)]?.maxWallClockMs ?? SCAN_TIER_CONFIG.solo.maxWallClockMs
      const timeoutMs = tierCeilingMs + 4 * 60 * 1000
      const ageMs = Date.now() - record.startedAt
      if (ageMs > timeoutMs) {
        return new Response(JSON.stringify({ ...record, status: 'done', reason: 'timed_out' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }

    return new Response(JSON.stringify(record || { status: 'unknown' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('[scan-status] failed to read status blob:', err.message)
    await reportServerError('scan-status', err)
    return unknown()
  }
}
