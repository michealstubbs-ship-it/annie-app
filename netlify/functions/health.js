// A production-readiness audit (2026-08-22) found no health-check endpoint
// anywhere in the app — no external uptime monitor (or Netlify itself) had
// any way to detect "the site is up but the database is unreachable"
// short of a customer complaining. This is deliberately public (no auth):
// uptime monitors and status pages call it anonymously, and it leaks
// nothing sensitive — a boolean per dependency, never a value, a key, or
// an error message body.
import { createClient } from '@supabase/supabase-js'

export default async () => {
  const checks = { database: 'unknown' }
  let healthy = true

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceKey) {
    checks.database = 'not_configured'
    healthy = false
  } else {
    try {
      const supabase = createClient(supabaseUrl, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
      // Cheapest possible real round-trip to Postgres: a head-only count
      // against a tiny, always-present table. Not RLS-relevant (service
      // role), not expensive, but it does prove the DB is actually
      // reachable and answering — a real query, not just "did fetch not
      // throw" against Supabase's REST gateway.
      const { error } = await supabase.from('profiles').select('id', { count: 'exact', head: true }).limit(1)
      if (error) {
        checks.database = 'error'
        healthy = false
      } else {
        checks.database = 'ok'
      }
    } catch {
      checks.database = 'error'
      healthy = false
    }
  }

  return new Response(JSON.stringify({ status: healthy ? 'ok' : 'degraded', checks }), {
    status: healthy ? 200 : 503,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

export const config = { path: '/api/health' }
