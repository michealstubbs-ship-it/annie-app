// The monthly contact allowance shown at the top of the stream.
//
// Read through an endpoint rather than straight from Supabase because the
// LIMIT depends on the team's plan tier, and tier resolution (team membership,
// subscription status, admin override) lives server-side in entitlements.js.
import { supabase } from '../supabase'
import { withTimeout } from '../withTimeout'

export async function fetchContactCredits() {
  try {
    const { data: { session } } = await withTimeout(supabase.auth.getSession(), 8000, 'contact-credits-session')
    const token = session?.access_token
    if (!token) return null
    const res = await fetch('/api/contact-credits', { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) return null
    const body = await res.json()
    if (body?.configured === false) return null
    if (!Number.isFinite(body?.limit)) return null
    return {
      used: Number(body.used) || 0,
      limit: Number(body.limit),
      topupBalance: Number(body.topupBalance) || 0,
      remaining: Number(body.remaining) || 0,
      tier: body.tier || null,
    }
  } catch {
    // A meter is a nicety. Never let it break the page it sits on.
    return null
  }
}
