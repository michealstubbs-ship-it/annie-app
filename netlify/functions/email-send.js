// Sending the drafted approach from the recruiter's own mailbox.
//
// This is the button that does not exist today: the draft already works, it
// just ends at "Copy". Sending through their own account means it lands in
// their sent items, threads normally, and any reply comes back to them — not
// to a no-reply address on Annie's domain.
//
// The sent message is ingested immediately rather than waiting for the next
// sweep, so the note is on the contact before they navigate away.
import { createClient } from '@supabase/supabase-js'
import { getAuthedUser } from './lib/auth.js'
import { getEntitlements } from './lib/entitlements.js'
import { jsonError } from './lib/httpError.js'
import { reportServerError } from './lib/reportError.js'
import { unipileConfig, sendEmail, listEmails } from './lib/unipile.js'
import { ingestMessage } from './lib/emailIngest.js'

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
})

export default async (req) => {
  if (req.method !== 'POST') return jsonError(405, 'Method not allowed')

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !anonKey || !serviceKey) return jsonError(503, 'Not configured')

  const { user, error: authError } = await getAuthedUser(req, supabaseUrl, anonKey)
  if (authError || !user) return jsonError(401, 'Not authenticated')

  let payload = {}
  try { payload = await req.json() } catch { return jsonError(400, 'Invalid request') }

  const to = String(payload.to || '').trim()
  const subject = String(payload.subject || '').trim()
  const bodyText = String(payload.body || '').trim()
  if (!to || !to.includes('@')) return jsonError(400, 'A recipient address is required')
  if (!subject) return jsonError(400, 'A subject is required')
  if (!bodyText) return jsonError(400, 'The message is empty')

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

  try {
    const ent = await getEntitlements(admin, user.id)
    if (!ent?.limits?.emailSync) return json(402, { error: 'Sending is on Growth and Team', upgrade: true })

    const { data: account } = await admin
      .from('email_accounts')
      .select('id, user_id, email_address, unipile_account_id, status')
      .eq('user_id', user.id)
      .eq('status', 'connected')
      .maybeSingle()

    if (!account) return json(409, { error: 'No mailbox connected', connect: true })

    const cfg = unipileConfig()
    const sent = await sendEmail(cfg, {
      accountId: account.unipile_account_id,
      to,
      subject,
      body: bodyText,
    })

    if (!sent.ok) {
      await reportServerError('email-send', new Error(sent.error || 'send_failed'), { userId: user.id })
      return jsonError(502, 'The message could not be sent')
    }

    // Log it now. If this half fails the mail has still gone — so the note is
    // best-effort and never turns a delivered message into an error the user
    // sees, which would invite them to send it twice.
    let logged = null
    try {
      const id = sent.data?.id || sent.data?.email_id || null
      let message = null
      if (id) {
        const found = await listEmails(cfg, { accountId: account.unipile_account_id, role: 'sent', limit: 5 })
        message = (found.data?.items || []).find(m => m.id === id) || null
      }
      if (!message) {
        message = {
          id: id || `sent:${Date.now()}`,
          date: new Date().toISOString(),
          subject,
          from_attendee: { identifier: account.email_address },
          to_attendees: [{ identifier: to }],
          body_plain: bodyText,
        }
      }
      logged = await ingestMessage(admin, {
        userId: user.id,
        account,
        message,
        anthropicKey: process.env.ANTHROPIC_API_KEY || null,
      })
    } catch (err) {
      await reportServerError('email-send-log', err, { userId: user.id })
    }

    return json(200, { sent: true, contactId: logged?.contactId || null, note: logged?.noted || false })
  } catch (err) {
    await reportServerError('email-send', err, { userId: user.id })
    return jsonError(500, 'Something went wrong')
  }
}
