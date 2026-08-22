// Relays the "Launch Annie" onboarding save through Annie's own domain instead
// of having the browser call supabase.co directly. Some antivirus "web
// protection", ad blockers, and corporate network filters silently intercept
// background API writes to third-party domains even while the site itself
// loads fine — exactly the failure mode that was blocking onboarding
// completion. Routing through this function makes the browser's only request
// a normal same-origin POST to app.meetannie.ai, which nothing filters.
//
// This function has no more access than the caller already has: it uses the
// caller's own access token to scope the Supabase client, so the same RLS
// policies (auth.uid() = user_id) apply exactly as they would to a direct
// browser call. It cannot act as any other user.
import { reportServerError } from './lib/reportError.js'
import { sendWelcomeEmail } from './lib/email.js'
import { getAuthedClient } from './lib/auth.js'
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

  const { firmName, sectors, functions: onboardingFunctions, locations, tone } = body || {}
  if (!Array.isArray(sectors) || !Array.isArray(onboardingFunctions) || !Array.isArray(locations)) {
    return jsonError(400, 'Invalid onboarding data')
  }
  // These three arrays flow directly into every future scan's AI prompt for
  // this account (see buildScanPrompt) — an unbounded array or an oversized
  // string in one of them (an accidental paste, or deliberate abuse) would
  // silently inflate Anthropic input-token cost on every scan of this
  // account, forever, with nothing downstream to catch it.
  const MAX_ITEMS = 20
  const MAX_ITEM_LENGTH = 100
  for (const list of [sectors, onboardingFunctions, locations]) {
    if (list.length > MAX_ITEMS || list.some(v => typeof v !== 'string' || v.length > MAX_ITEM_LENGTH)) {
      return jsonError(400, `Each of sectors/functions/locations must have at most ${MAX_ITEMS} items of at most ${MAX_ITEM_LENGTH} characters each.`)
    }
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY
  if (!supabaseUrl || !anonKey) {
    return jsonError(500, 'Not configured')
  }

  const { client: supabase, user, error: authError } = await getAuthedClient(req, supabaseUrl, anonKey)
  if (authError) {
    const status = authError === 'missing_token' ? 401 : authError === 'invalid_session' ? 401 : 500
    return jsonError(status, 'Your session has expired. Please log in again.')
  }
  const userId = user.id

  const { error: onboardErr } = await supabase.from('onboarding').upsert({
    user_id: userId,
    firm_name: firmName || '',
    sectors,
    functions: onboardingFunctions,
    locations,
    tone: tone || 'professional',
  }, { onConflict: 'user_id' })
  if (onboardErr) {
    await reportServerError('save-onboarding', onboardErr, { userId, stage: 'onboarding-upsert' })
    return jsonError(400, onboardErr.message)
  }

  const { error: profileErr } = await supabase
    .from('profiles')
    .update({ onboarding_completed: true, firm_name: firmName || '' })
    .eq('id', userId)
  if (profileErr) {
    await reportServerError('save-onboarding', profileErr, { userId, stage: 'profile-update' })
    return jsonError(400, profileErr.message)
  }

  // Fire-and-forget: sendWelcomeEmail already never throws (see
  // lib/email.js), and onboarding's own success response shouldn't wait on
  // an email provider round-trip — the save already happened, that's what
  // the client is waiting on.
  //
  // Bug fix (this pass): this referenced an undefined `userData` variable —
  // getAuthedClient's destructured result above is named `user`, not
  // `userData`. That's a synchronous ReferenceError thrown while
  // constructing this call's arguments, before .catch() ever attaches to
  // anything — it would have crashed the whole request handler AFTER the
  // onboarding save above had already succeeded, on every single onboarding
  // completion, the moment a real user.email was needed instead of the
  // welcome-email call silently never firing.
  sendWelcomeEmail(user.email, firmName).catch(() => {})

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
