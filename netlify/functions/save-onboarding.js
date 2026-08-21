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
import { createClient } from '@supabase/supabase-js'
import { reportServerError } from './lib/reportError.js'
import { sendWelcomeEmail } from './lib/email.js'

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 })
  }

  const authHeader = req.headers.get('authorization') || ''
  const token = authHeader.replace(/^Bearer\s+/i, '').trim()
  if (!token) {
    return new Response(JSON.stringify({ error: 'Missing auth token' }), { status: 401 })
  }

  let body
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), { status: 400 })
  }

  const { firmName, sectors, functions: onboardingFunctions, locations, tone } = body || {}
  if (!Array.isArray(sectors) || !Array.isArray(onboardingFunctions) || !Array.isArray(locations)) {
    return new Response(JSON.stringify({ error: 'Invalid onboarding data' }), { status: 400 })
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY
  if (!supabaseUrl || !anonKey) {
    return new Response(JSON.stringify({ error: 'Not configured' }), { status: 500 })
  }

  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: userData, error: userErr } = await supabase.auth.getUser(token)
  if (userErr || !userData?.user) {
    return new Response(JSON.stringify({ error: 'Your session has expired. Please log in again.' }), { status: 401 })
  }
  const userId = userData.user.id

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
    return new Response(JSON.stringify({ error: onboardErr.message }), { status: 400 })
  }

  const { error: profileErr } = await supabase
    .from('profiles')
    .update({ onboarding_completed: true, firm_name: firmName || '' })
    .eq('id', userId)
  if (profileErr) {
    await reportServerError('save-onboarding', profileErr, { userId, stage: 'profile-update' })
    return new Response(JSON.stringify({ error: profileErr.message }), { status: 400 })
  }

  // Fire-and-forget: sendWelcomeEmail already never throws (see
  // lib/email.js), and onboarding's own success response shouldn't wait on
  // an email provider round-trip — the save already happened, that's what
  // the client is waiting on.
  sendWelcomeEmail(userData.user.email, firmName).catch(() => {})

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
