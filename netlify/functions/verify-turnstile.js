// Server-side half of Cloudflare Turnstile bot protection on signup (see
// README's "Known gaps" — this closes that gap). The widget itself
// (src/components/Turnstile.jsx) only proves a browser solved a challenge;
// trusting that from the client alone would be pointless, since anyone can
// skip calling it and go straight to Supabase's signUp. This function is
// the one thing a bot can't skip: Login.jsx calls it with the widget's
// token before calling signUp, and Cloudflare's own siteverify endpoint is
// the only thing that can confirm that token is real, unused, and recent.
//
// No auth here by design — the person calling this isn't logged in yet,
// that's the whole point of gating signup. It leaks nothing sensitive: a
// boolean back to the frontend, never Cloudflare's response body.
import { jsonError } from './lib/httpError.js'
import { reportServerError } from './lib/reportError.js'

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

export default async (req, context) => {
  if (req.method !== 'POST') {
    return jsonError(405, 'Method not allowed')
  }

  const secretKey = process.env.TURNSTILE_SECRET_KEY
  if (!secretKey) {
    // Same reasoning as chat.js/save-onboarding.js's 500 for a missing
    // required var: once this is wired up, an unset key on the server side
    // is a genuine misconfiguration, not an optional feature going quiet.
    return jsonError(500, 'Bot verification is not configured')
  }

  let body
  try {
    body = await req.json()
  } catch {
    return jsonError(400, 'Invalid request body')
  }

  const { token } = body || {}
  if (!token || typeof token !== 'string') {
    return jsonError(400, 'Missing verification token')
  }

  try {
    const params = new URLSearchParams({ secret: secretKey, response: token })
    if (context?.ip) params.set('remoteip', context.ip)

    const cfResponse = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    })
    const result = await cfResponse.json()

    if (!result.success) {
      return jsonError(400, 'Verification failed. Please try again.')
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    await reportServerError('verify-turnstile', err)
    return jsonError(500, 'Verification failed. Please try again.')
  }
}
