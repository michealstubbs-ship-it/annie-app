// The contact-credit meter the stream shows at the top of the page.
//
// A separate read-only endpoint rather than a direct Supabase query from the
// browser, because the monthly LIMIT comes from the team's plan tier
// (TIER_LIMITS in entitlements.js) and that resolution — team membership,
// subscription row, admin override — deliberately lives server-side. The
// usage row itself is readable by the owning team under RLS; the limit is not
// something a client should be computing for itself.
import { createClient } from '@supabase/supabase-js'
import { createTimeoutFetch } from './lib/scanShared.js'
import { getAuthedUser } from './lib/auth.js'
import { jsonError } from './lib/httpError.js'
import { getEntitlements, getContactCredits } from './lib/entitlements.js'

export default async (req) => {
  if (req.method !== 'GET') return jsonError(405, 'Method not allowed')

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !anonKey || !serviceKey) {
    // A missing meter must never block the stream from rendering.
    return new Response(JSON.stringify({ configured: false }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  const { user, error: authError } = await getAuthedUser(req, supabaseUrl, anonKey)
  if (authError) return jsonError(401, authError === 'missing_token' ? 'Missing session token' : 'Invalid session')

  const supabase = createClient(supabaseUrl, serviceKey, { global: { fetch: createTimeoutFetch() } })
  const { tier, teamId } = await getEntitlements(supabase, user.id)
  const credits = await getContactCredits(supabase, teamId, tier)

  return new Response(JSON.stringify({ ...credits, tier }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

export const config = { path: '/api/contact-credits' }
