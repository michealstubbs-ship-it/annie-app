// Throttled frontend caller for netlify/functions/touch-activity.js — see
// that file's own header for what it writes and why. This module exists so
// every authenticated screen can call ping() freely (on mount, on route
// change, on any real interaction) without turning "the user is active"
// into a stream of network calls: real usage bursts dozens of times a
// minute, and this endpoint only needs to know "active today," not "active
// this second."
import { supabase } from './supabase'
import { withTimeout } from './withTimeout'
import { reportClientError } from './errorReporting'

const THROTTLE_MS = 10 * 60 * 1000 // one ping per 10 minutes is plenty for a daily/weekly-inactivity signal
let lastPingAt = 0
let inFlight = false

// Exported for tests only — resets the module-level throttle state between
// cases so one test's ping doesn't suppress the next.
export function _resetActivityPingThrottleForTests() {
  lastPingAt = 0
  inFlight = false
}

export async function pingActivity() {
  const now = Date.now()
  if (inFlight || now - lastPingAt < THROTTLE_MS) return
  inFlight = true
  try {
    const { data: { session } } = await withTimeout(supabase.auth.getSession(), 8000, 'touch-activity-session')
    const token = session?.access_token
    if (!token) return
    lastPingAt = now // set before the await: a slow/failed request should still hold the throttle window
    await fetch('/api/touch-activity', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
  } catch (err) {
    // Best-effort by nature (see touch-activity.js header) — log it
    // client-side so a systemic failure is at least visible, never surface
    // it to the user.
    reportClientError('Activity ping failed to send', err, {})
  } finally {
    inFlight = false
  }
}
