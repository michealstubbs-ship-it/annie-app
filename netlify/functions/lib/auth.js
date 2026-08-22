// Verifies a caller's OWN Supabase session token and returns their user —
// never trust a client-supplied user_id, always derive identity from a
// token the caller can't forge. Centralized here after a scale-readiness
// audit (2026-08-22) found this ~10-line block duplicated, with only
// cosmetic variation, across eight-plus function files — exactly the kind
// of copy-pasted security logic that already caused one real gap
// (apollo-enrich-companies.js previously shipped with no auth check at
// all, per that file's own comment).
import { createClient } from '@supabase/supabase-js'

export function extractBearerToken(req) {
  const header = req.headers.get('authorization') || ''
  return header.replace(/^Bearer\s+/i, '').trim()
}

// Returns { user, error }. `error` is a short machine-readable reason
// ('missing_token' | 'not_configured' | 'invalid_session') — each call site
// decides its own response shape/status for a failure, since that already
// varies deliberately by endpoint (a cron returns 200 to avoid retry
// storms, a user-facing API returns 401), this helper only owns the actual
// verification, not the HTTP response.
export async function getAuthedUser(req, supabaseUrl, anonKey) {
  const { user, error } = await getAuthedClient(req, supabaseUrl, anonKey)
  return { user, error }
}

// Same verification as getAuthedUser, but also returns the token-scoped
// client itself — for the handful of call sites (save-onboarding.js) that
// reuse that same client for subsequent RLS-respecting writes as the caller,
// rather than switching to a service-role client afterward.
export async function getAuthedClient(req, supabaseUrl, anonKey) {
  const token = extractBearerToken(req)
  if (!token) return { client: null, user: null, error: 'missing_token' }
  if (!supabaseUrl || !anonKey) return { client: null, user: null, error: 'not_configured' }

  const client = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data, error } = await client.auth.getUser(token)
  if (error || !data?.user) return { client: null, user: null, error: 'invalid_session' }
  return { client, user: data.user, error: null }
}
