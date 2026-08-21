// Lets the dashboard ask "is my post-onboarding research scan still
// running, or did it finish, and what actually happened?" instead of just
// guessing off a fixed timer. A fast, cheap, synchronous read of the status
// blob that scan-now-background.js writes — this function does no research
// itself, no Anthropic/Apollo calls, just a lookup.
import { createClient } from '@supabase/supabase-js'
import { getStore } from '@netlify/blobs'

export default async (req) => {
  const unknown = () => new Response(JSON.stringify({ status: 'unknown' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

  const authHeader = req.headers.get('authorization') || ''
  const token = authHeader.replace(/^Bearer\s+/i, '').trim()
  if (!token) return unknown()

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY
  if (!supabaseUrl || !anonKey) return unknown()

  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: userData, error } = await authClient.auth.getUser(token)
  if (error || !userData?.user) return unknown()

  try {
    const store = getStore({ name: 'annie-scan-status', consistency: 'strong' })
    const record = await store.get(userData.user.id, { type: 'json' })

    // scan-now-background.js has a 15-minute wall-clock budget. If it gets
    // hard-killed mid-run (a hung external call, an unhandled error before
    // the catch block), it can leave the status blob stuck on "running"
    // forever, with no terminal status ever written — which otherwise means
    // the dashboard's "Annie is researching" state never resolves. Treat a
    // "running" status older than that budget as timed out rather than
    // trusting it verbatim.
    if (record?.status === 'running' && record?.startedAt) {
      const ageMs = Date.now() - record.startedAt
      if (ageMs > 14 * 60 * 1000) {
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
    return unknown()
  }
}
