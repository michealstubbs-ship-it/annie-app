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
import { recordApproach } from './lib/outreachApproach.js'

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
})

/**
 * The signal this approach came from, or null.
 *
 * Scoped to the caller's own rows on purpose: a request body cannot name a
 * lead it does not own, same rule email-webhook.js applies to the account id.
 * An unknown or foreign id simply produces an approach with no lead attached,
 * rather than an error — the mail has already been sent by this point.
 */
async function loadOwnSignal(admin, userId, signalId) {
  try {
    const { data } = await admin
      .from('intelligence_signals')
      .select('id, signal_type, company_name')
      .eq('id', signalId)
      .eq('user_id', userId)
      .maybeSingle()
    return data || null
  } catch {
    return null
  }
}

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
  // Which lead this approach came from. Optional — a message sent from
  // anywhere but a feed card has none, and that is a fine thing for an
  // approach row to be missing. Never trusted as given: it is looked up
  // against this user's own signals below before anything is written.
  const signalId = String(payload.signalId || '').trim() || null
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

      // The approach itself, against the lead and the contact — not merely as
      // a row in the mail ledger. This is what a reply is later matched to;
      // without it a reply is just another inbound email and the loop stays
      // open forever.
      //
      // Same best-effort contract as the note above, and for the same reason:
      // the message has gone.
      const signal = signalId ? await loadOwnSignal(admin, user.id, signalId) : null
      await recordApproach(admin, {
        userId: user.id,
        signalId: signal?.id || null,
        signalType: signal?.signal_type || null,
        contactId: logged?.contactId || null,
        companyId: logged?.companyId || null,
        // The signal's company name is the one the customer sees on the card;
        // the ingest's is derived from the recipient's domain. Prefer the one
        // they would recognise, fall back to the one that is always there.
        companyName: signal?.company_name || logged?.companyName || null,
        toEmail: to,
        subject,
        sentAt: message.date || new Date().toISOString(),
        emailMessageId: logged?.ledgerId || null,
        threadId: message.thread_id || null,
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

// Netlify: a custom path replaces the default /.netlify/functions/ alias,
// so this is the ONLY URL this function answers on.
export const config = { path: '/api/email-send' }
