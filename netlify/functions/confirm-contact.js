// A customer adding a signal's contact to their own CRM (addToCrm in
// IntelligenceFeed.jsx) is a much stronger signal than Apollo's raw guess —
// a human just looked at that name/title and decided it was worth pursuing.
// This is the feedback half of the shared company_contacts cache: instead
// of that confirmation being thrown away, it bumps the matching cache row's
// confidence (confirmed_by_customers) and refreshes its trust window
// (checked_at), the same way a fresh Apollo lookup would, but without
// spending a credit — future lookups for that same company + role, from any
// customer, get a row that's both cheaper AND more trustworthy over time.
//
// Deliberately update-only, never insert: if a signal has a contact_name at
// all, verifyContact() already wrote that contact to company_contacts when
// the signal itself was created (see scanShared.js), so there's always an
// existing row to confirm. If the key doesn't match anything (e.g. an old
// signal predating this cache), the RPC just updates zero rows — a safe,
// silent no-op, not an error.
import { createClient } from '@supabase/supabase-js'
import { normalizeCompanyKey, titleBucketKey, createTimeoutFetch } from './lib/scanShared.js'
import { reportServerError } from './lib/reportError.js'
import { getAuthedUser } from './lib/auth.js'
import { jsonError } from './lib/httpError.js'

export default async (req) => {
  if (req.method !== 'POST') {
    return jsonError(405, 'Method not allowed')
  }

  let body
  try {
    body = await req.json()
  } catch {
    return jsonError(400, 'Invalid request body')
  }

  const { company, titleKeywords } = body || {}
  if (!company || typeof company !== 'string') {
    return jsonError(400, 'Missing company')
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return jsonError(500, 'Not configured')
  }

  // Require a real logged-in caller — this only guards against anonymous
  // abuse of the endpoint (spamming confidence bumps), not per-customer data
  // access, since company_contacts is a shared, cross-customer cache with
  // nothing customer-specific in it.
  const { user, error: authError } = await getAuthedUser(req, supabaseUrl, anonKey)
  if (authError) {
    return jsonError(401, 'Your session has expired. Please log in again.')
  }

  // 2026-08-24 Task 3: createTimeoutFetch applied — see its own header in
  // scanShared.js.
  const supabase = createClient(supabaseUrl, serviceKey, { global: { fetch: createTimeoutFetch() } })
  const companyKey = normalizeCompanyKey(company)
  const titleKey = titleBucketKey(titleKeywords)

  try {
    const { error } = await supabase.rpc('bump_contact_confirmation', {
      p_company_key: companyKey,
      p_title_key: titleKey,
    })
    if (error) {
      await reportServerError('confirm-contact', error, { companyKey, titleKey })
      return jsonError(400, error.message)
    }
  } catch (err) {
    await reportServerError('confirm-contact', err, { companyKey, titleKey })
    return jsonError(500, 'Failed to confirm contact')
  }

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
