// Updates the caller's own profiles.last_active_at to now(). This is the
// one write behind the "at risk / inactive" member flag and the churn-risk
// insight on Annie Overview — see that migration's own header for why this
// didn't exist before. Deliberately minimal: one UPDATE, on the caller's
// own token-scoped client (never a service-role write, never trusting a
// client-supplied user id), no request body to parse at all. The frontend
// throttles how often it calls this (see src/lib/activityPing.js) — this
// endpoint itself has no rate limiting of its own because a stray extra
// call just re-writes the same timestamp a few seconds earlier, which is
// harmless, unlike an unbounded third-party API spend elsewhere in this
// codebase that genuinely needs a cap.
import { getAuthedClient } from './lib/auth.js'
import { reportServerError } from './lib/reportError.js'

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } })
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY
  if (!supabaseUrl || !anonKey) {
    return new Response(JSON.stringify({ error: 'Not configured' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }

  const { client, user, error: authError } = await getAuthedClient(req, supabaseUrl, anonKey)
  if (authError) {
    return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
  }

  try {
    const { error } = await client.from('profiles').update({ last_active_at: new Date().toISOString() }).eq('id', user.id)
    if (error) throw new Error(error.message)
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    // Best-effort by nature (see header) — report it, but never make a
    // failed activity ping look like a real error to the customer.
    await reportServerError('touch-activity', err, { userId: user.id })
    return new Response(JSON.stringify({ ok: false }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
}

export const config = { path: '/api/touch-activity' }
