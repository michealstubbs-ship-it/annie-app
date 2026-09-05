// 2026-08-26: backs the "OpEx today" panel on the admin Overview tab
// (AdminOverview.jsx). That panel shows real spend against a daily
// ceiling, and the ceiling has to come from the one real source of truth
// for it — resolveResourceCaps()/DEFAULT_PLATFORM_CAPS in entitlements.js,
// the exact same numbers every real apollo_reserve_credits/
// theirstack_reserve_credits/anthropic_reserve_tokens call is checked
// against, including whatever env-var override (APOLLO_DAILY_CREDIT_CAP
// etc.) is actually set in Netlify right now. The dashboard previously had
// its own separate hardcoded copies of these numbers (500 / 2,000,000)
// which had already gone stale the moment entitlements.js's own defaults
// changed underneath them, with nothing to catch that. This endpoint
// exists so there is exactly one number, not two: it returns the live
// values, it doesn't hold a second copy of them.
//
// This can't be a Postgres RPC like every other admin-overview read
// (get_admin_account_summary etc.) — the values it returns live in
// application code and Netlify env vars, not in the database. The
// authorization bar is identical to those RPCs (is_admin, checked
// server-side, never just hidden client-side); it's just enforced here in
// JS instead of inside a SECURITY DEFINER function, because that's where
// the data actually lives.
//
// platformDailyCap doesn't vary by tier — only userDailyCap does — so
// calling resolveResourceCaps() with any tier and reading the platform
// side back out is correct regardless of which tier is passed in.
import { createClient } from '@supabase/supabase-js'
import { getAuthedUser } from './lib/auth.js'
import { resolveResourceCaps } from './lib/entitlements.js'
import { jsonError } from './lib/httpError.js'
import { createTimeoutFetch } from './lib/scanShared.js'
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
    // Same is_admin gate every other admin-overview read goes through —
    // checked here in application code rather than inside a SQL function
    // only because these particular values don't live in Postgres at all.
    const supabase = createClient(supabaseUrl, serviceKey, { global: { fetch: createTimeoutFetch() } })
    const { data: profile, error: profileError } = await supabase.from('profiles').select('is_admin').eq('id', user.id).maybeSingle()
    if (profileError || !profile?.is_admin) {
      return jsonError(403, 'Not authorized')
    }

    const caps = resolveResourceCaps('solo')
    return new Response(JSON.stringify({
      apollo: caps.apollo.platformDailyCap,
      theirStack: caps.theirStack.platformDailyCap,
      anthropicTokens: caps.anthropicTokens.platformDailyCap,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    await reportServerError('admin-resource-caps', err)
    return jsonError(500, err.message || 'Something went wrong')
  }
}
