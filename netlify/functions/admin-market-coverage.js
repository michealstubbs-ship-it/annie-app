// 2026-08-27: backs a new "Market coverage" panel on the admin Overview tab
// (AdminOverview.jsx) — the ongoing, self-updating answer to a question the
// 19-scenario staged audit earlier this session could only answer as a
// one-time manual snapshot: which sector/location combinations Annie
// actually offers on the signup form are structurally thin (real, repeated
// scan attempts across multiple customers, consistently nothing found)
// versus which just haven't come up much yet.
//
// Same is_admin gate as every other admin-overview read (get_admin_*
// RPCs, admin-resource-caps.js), enforced server-side. This is a JS
// endpoint rather than a SECURITY DEFINER Postgres RPC like most of the
// others purely because the aggregation logic (getMarketCoverageReport)
// already lives in scanShared.js, unit-tested there — duplicating it as a
// second implementation in raw SQL would be exactly the kind of drift risk
// this codebase has repeatedly found and fixed elsewhere this session.
import { createClient } from '@supabase/supabase-js'
import { getAuthedUser } from './lib/auth.js'
import { jsonError } from './lib/httpError.js'
import { createTimeoutFetch, getMarketCoverageReport } from './lib/scanShared.js'
import { reportServerError } from './lib/reportError.js'

export default async (req) => {
  if (req.method !== 'GET') {
    return jsonError(405, 'Method not allowed')
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return jsonError(500, 'Not configured')
  }

  const { user, error: authError } = await getAuthedUser(req, supabaseUrl, anonKey)
  if (authError || !user) {
    return jsonError(401, 'Invalid session')
  }

  try {
    const supabase = createClient(supabaseUrl, serviceKey, { global: { fetch: createTimeoutFetch() } })
    const { data: profile, error: profileError } = await supabase.from('profiles').select('is_admin').eq('id', user.id).maybeSingle()
    if (profileError || !profile?.is_admin) {
      return jsonError(403, 'Not authorized')
    }

    const report = await getMarketCoverageReport(supabase, { sinceDays: 30, minScans: 5, minCustomers: 3 })
    return new Response(JSON.stringify({ pairs: report }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    await reportServerError('admin-market-coverage', err)
    return jsonError(500, err.message || 'Something went wrong')
  }
}
