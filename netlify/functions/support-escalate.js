// Fired by SupportWidget.jsx whenever Annie's own system prompt judges a
// conversation needs a human — a refund/billing dispute, a GDPR data
// request, a reproducible bug, or someone directly asking for a person
// (see src/lib/supportEscalation.js for how that's detected from Annie's
// reply). Per Michael's own call (2026-08-26), this still goes straight to
// his real inbox in real time rather than waiting to be found on a
// dashboard, since he's the entire support team today. It never blocks or
// changes what the customer sees — the widget fires this without awaiting
// it.
//
// 2026-09-02: this now ALSO writes a row to support_escalations (see that
// migration's own header) — until this change, the email was the only
// record of an escalation ever existing, so the Annie Overview "Client
// Escalations" tab had no real data to read: no open/resolved counts, no
// time-to-first-response, nothing. The email stays exactly as before; the
// row is what makes that tab real instead of mocked.
import { createClient } from '@supabase/supabase-js'
import { reportServerError } from './lib/reportError.js'
import { getAuthedUser } from './lib/auth.js'
import { sendSupportEscalationEmail } from './lib/email.js'
import { createTimeoutFetch } from './lib/scanShared.js'

// A customer could in principle keep a support chat open indefinitely —
// bound how much of it ever lands in one email rather than trusting the
// client to always send something reasonable.
const MAX_EXCERPT_CHARS = 4000

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } })
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  // Read at request time, like every env var elsewhere in this file — not
  // module scope, so a Netlify env-var change takes effect on the very next
  // invocation of an already-warm function instance rather than needing a
  // fresh cold start.
  const escalationInbox = process.env.SUPPORT_ESCALATION_EMAIL || 'mstubbs@meetannie.ai'
  if (!supabaseUrl || !anonKey) {
    return new Response(JSON.stringify({ error: 'Not configured' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }

  // Same rule as chat.js and every other customer-facing function: verified
  // from the caller's own session token, never trusted from the request
  // body — otherwise anyone could spam Michael's inbox with fake escalations.
  const { user, error: authError } = await getAuthedUser(req, supabaseUrl, anonKey)
  if (authError) {
    return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
  }

  let body
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }

  const category = typeof body.category === 'string' ? body.category : 'unresolved'
  const excerpt = typeof body.excerpt === 'string' ? body.excerpt.slice(-MAX_EXCERPT_CHARS) : ''

  try {
    // Firm name for the email subject/body — best-effort only. A lookup
    // failure here should never be the reason the escalation email doesn't
    // go out; the email is still useful with just the customer's own
    // account email (from their verified session) even without it.
    let firmName = null
    const supabase = serviceKey ? createClient(supabaseUrl, serviceKey, { global: { fetch: createTimeoutFetch() } }) : null
    if (supabase) {
      const { data: profile } = await supabase.from('profiles').select('firm_name').eq('id', user.id).maybeSingle()
      firmName = profile?.firm_name || null
    }

    const sent = await sendSupportEscalationEmail(escalationInbox, {
      customerEmail: user.email,
      firmName,
      category,
      excerpt,
    })

    if (!sent) {
      // Not configured (no RESEND_API_KEY) or Resend itself failed — worth
      // knowing about (a silently-dropped escalation is exactly the kind of
      // failure that shouldn't go unnoticed), but never worth failing the
      // request over: the customer's own conversation already succeeded.
      await reportServerError('support-escalate', new Error('escalation email did not send'), { userId: user.id, category })
    }

    // Best-effort, same reasoning as the firm-name lookup above: a failure
    // to write this row should never be why the customer-facing request
    // fails — it would just mean this one escalation is missing from the
    // Overview tab's counts, not that the escalation itself was lost (the
    // email still went out).
    if (supabase) {
      const { error: insertError } = await supabase.from('support_escalations').insert({
        user_id: user.id,
        firm_name: firmName,
        customer_email: user.email,
        category,
        excerpt,
      })
      if (insertError) {
        await reportServerError('support-escalate', new Error(`escalation row insert failed: ${insertError.message}`), { userId: user.id, category })
      }
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    await reportServerError('support-escalate', err, { userId: user.id, category })
    // Still 200 — the widget fires this fire-and-forget and never surfaces
    // its result to the customer either way; the only thing a 500 here
    // would change is noisier error logs for a non-critical side effect.
    return new Response(JSON.stringify({ ok: false }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
}

export const config = { path: '/api/support-escalate' }
