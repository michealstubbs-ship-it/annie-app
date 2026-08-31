// Resend's delivery webhook — email.delivered, email.bounced,
// email.complained, email.delivery_delayed. Closes the gap found while
// investigating a customer report of an invoice email that never arrived:
// send-invoice.js only ever knew "did Resend's API accept this send", never
// what actually happened after that. An invoice stayed marked 'sent'
// forever regardless of whether the client's inbox ever really got it.
//
// This endpoint is public by necessity (Resend's servers call it directly,
// no user session exists) — signature verification is the ONLY thing
// standing between this and anyone POSTing a fake "delivered" event, same
// reasoning as stripe-webhook.js's own header. Never skip it.
//
// Resend signs webhooks the Svix way (Svix is the delivery infrastructure
// Resend uses under the hood, documented at docs.svix.com/receiving/
// verifying-payloads/how-manual-verification-works): the raw signing
// secret is base64 after a `whsec_` prefix; the signed content is exactly
// `${svix-id}.${svix-timestamp}.${raw body}`; HMAC-SHA256 that with the
// decoded secret, base64-encode the result, and it must match one of the
// space-separated `v1,<sig>` tokens in the svix-signature header. No SDK
// dependency needed for this — it's a same handful of lines with Node's
// built-in crypto, and this is the only place in the codebase that would
// use it.
import { createClient } from '@supabase/supabase-js'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { reportServerError } from './lib/reportError.js'
import { alertIfConfigured, createTimeoutFetch } from './lib/scanShared.js'

// Svix's own recommended replay-protection window — reject a webhook whose
// timestamp is further from "now" than this, even with a valid signature.
const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60

function verifySignature({ svixId, svixTimestamp, svixSignature, rawBody, secret }) {
  if (!svixId || !svixTimestamp || !svixSignature || !secret) return false

  const nowSeconds = Math.floor(Date.now() / 1000)
  const ts = Number(svixTimestamp)
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > MAX_TIMESTAMP_SKEW_SECONDS) return false

  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`
  const expected = createHmac('sha256', secretBytes).update(signedContent, 'utf8').digest('base64')
  const expectedBuf = Buffer.from(expected, 'base64')

  // svix-signature can carry more than one `v1,<sig>` token (e.g. during a
  // secret rotation) — accept if any of them match.
  return svixSignature.split(' ').some(token => {
    const sig = token.startsWith('v1,') ? token.slice(3) : token
    let sigBuf
    try {
      sigBuf = Buffer.from(sig, 'base64')
    } catch {
      return false
    }
    return sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf)
  })
}

// Resend's event `type` values map to these. Anything not listed here
// (email.sent, email.opened, email.clicked, …) is acknowledged and ignored —
// this endpoint only tracks the outcomes that matter for "did the client
// actually get their invoice".
const STATUS_BY_EVENT_TYPE = {
  'email.delivered': 'delivered',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.delivery_delayed': 'delayed',
}

// A 'bounced' or 'complained' status is the actionable truth about this
// send — never let a late or out-of-order 'delivered'/'delayed' event
// silently overwrite it back to looking fine.
const TERMINAL_BAD_STATUSES = new Set(['bounced', 'complained'])

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const webhookSecret = process.env.RESEND_WEBHOOK_SECRET
  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!webhookSecret || !supabaseUrl || !serviceKey) {
    // Not configured yet — 200 so Resend doesn't spend its retry budget on
    // an endpoint that isn't ready, but nothing here is trusted or acted on.
    return new Response('Not configured', { status: 200 })
  }

  const rawBody = await req.text()
  const svixId = req.headers.get('svix-id')
  const svixTimestamp = req.headers.get('svix-timestamp')
  const svixSignature = req.headers.get('svix-signature')

  if (!verifySignature({ svixId, svixTimestamp, svixSignature, rawBody, secret: webhookSecret })) {
    console.error('[resend-webhook] signature verification failed')
    return new Response('Invalid signature', { status: 400 })
  }

  let event
  try {
    event = JSON.parse(rawBody)
  } catch {
    return new Response('Invalid payload', { status: 400 })
  }

  const supabase = createClient(supabaseUrl, serviceKey, { global: { fetch: createTimeoutFetch() } })

  // Same idempotency pattern as stripe-webhook.js: svix-id is Svix's own
  // unique delivery id, reserved via a single INSERT (event_id PRIMARY KEY)
  // before any handling runs, so a redelivered event hits a real
  // unique-violation instead of double-applying.
  const { error: reserveError } = await supabase.from('resend_webhook_events').insert({ event_id: svixId, event_type: event.type })
  if (reserveError) {
    if (reserveError.code === '23505') return new Response('ok (already processed)', { status: 200 })
    await reportServerError('resend-webhook', new Error(`event reservation failed: ${reserveError.message}`), { eventType: event.type, svixId })
    return new Response('ok', { status: 200 }) // don't fail the delivery over our own bookkeeping
  }

  const status = STATUS_BY_EVENT_TYPE[event.type]
  const emailId = event.data?.email_id
  if (!status || !emailId) return new Response('ok (ignored)', { status: 200 })

  try {
    const { data: invoice, error: findErr } = await supabase
      .from('invoices')
      .select('id, email_delivery_status')
      .eq('resend_email_id', emailId)
      .maybeSingle()
    if (findErr) throw findErr
    if (!invoice) {
      // Not every Resend send is an invoice email (welcome, payment-failed,
      // support-escalation emails go through the same Resend account but
      // are never given a resend_email_id to track) — expected, not an error.
      return new Response('ok (no matching invoice)', { status: 200 })
    }

    if (TERMINAL_BAD_STATUSES.has(invoice.email_delivery_status) && !TERMINAL_BAD_STATUSES.has(status)) {
      return new Response('ok (kept existing terminal status)', { status: 200 })
    }

    const { error: updateErr } = await supabase
      .from('invoices')
      .update({ email_delivery_status: status, email_delivery_updated_at: new Date().toISOString() })
      .eq('id', invoice.id)
    if (updateErr) throw updateErr

    // A spam complaint is a signal worth knowing about immediately, not
    // just something a customer stumbles onto later — it's the strongest
    // real-world signal of domain reputation risk, which affects every
    // customer sending through the same shared domain, not just this one
    // invoice.
    if (status === 'complained') {
      await alertIfConfigured(`⚠️ resend-webhook: a client marked an Annie invoice email as spam (invoice ${invoice.id}). Worth checking mail.meetannie.ai's sender reputation.`)
    }

    return new Response('ok', { status: 200 })
  } catch (err) {
    await reportServerError('resend-webhook', err, { eventType: event.type, emailId })
    return new Response('ok', { status: 200 }) // ack anyway — Resend's retry wouldn't fix a DB error, reportServerError already surfaced it
  }
}
