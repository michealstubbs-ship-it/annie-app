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
import { fetchWithTimeout } from './lib/scanShared.js'

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

    // Server-side sweep, 2026-08-29: this was the one remaining raw fetch()
    // in netlify/functions/ with no AbortController-backed timeout (every
    // other external call — Adzuna/TheirStack/Apollo/Clearbit in
    // scanShared.js, chat.js's own Anthropic call — already goes through
    // fetchWithTimeout for exactly this reason, see its header comment
    // there). A thrown error here was already caught below and turned into
    // a proper 500, but a true hang — Cloudflare's siteverify endpoint
    // never responding, never erroring — had nothing forcing it closed,
    // and this sits on the signup critical path: every new signup would
    // hang indefinitely with no error ever surfaced, not just this call.
    const cfResponse = await fetchWithTimeout(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    }, 10000)
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
