// Thin Resend wrapper for the handful of transactional emails Annie sends
// itself (auth emails — signup confirmation, password reset — stay on
// Supabase's own mailer, untouched by this file).
//
// Same fail-open philosophy as reportError.js and reserveApolloCredits: a
// broken or unconfigured email send must never be the reason a real
// feature (onboarding, a webhook handler) fails or throws. Every exported
// function here swallows its own errors and returns a boolean instead —
// callers can log or ignore the result, but never need to catch.
const FROM_ADDRESS = process.env.RESEND_FROM_ADDRESS || 'Annie <annie@mail.meetannie.ai>'

// Lazily imported for the same reason posthog-js is dynamically imported on
// the client (see src/lib/analytics.js): most Netlify function invocations
// never send an email, so there's no reason to pay for loading and
// constructing the Resend SDK on every cold start.
let resendPromise = null
function loadResend() {
  if (!resendPromise) {
    resendPromise = import('resend').then(({ Resend }) => {
      const key = process.env.RESEND_API_KEY
      return key ? new Resend(key) : null
    })
  }
  return resendPromise
}

// The one function every other helper in this file goes through. Returns
// true/false rather than throwing so a caller can decide whether a failed
// send is worth noting (e.g. reportServerError) without it ever being able
// to break the request that triggered it.
//
// 2026-08-26 audit finding: this used to swallow a real send failure (a
// revoked/rotated RESEND_API_KEY, a lapsed domain, Resend rate-limiting or
// an outage) with zero logging at all — no console.error, no
// reportServerError, nothing. Contrast with every other fail-open helper
// in this codebase (aiUsage.js, scanShared.js's reserve* functions), which
// always at least console.errors on failure. Checking who actually reads
// the returned boolean: save-onboarding.js and stripe-webhook.js's payment/
// trial-ending emails only `.catch(() => {})`, which guards a REJECTED
// promise — this function never rejects, it resolves `false` — so those
// call sites never actually saw a failure either. Only support-escalate.js
// checked the boolean and reported it. Logging here (not in every caller)
// means every future caller gets this for free, matching the file's own
// stated "callers can log or ignore the result" comment — that promise
// only actually holds now that there's something to see if they don't.
// The "not configured" case stays a silent no-op on purpose — that's an
// expected dev-environment state, not a failure.
// 2026-08-26: `attachments` added for send-invoice.js — Resend's own API
// takes an array of { filename, content } where content is base64, which
// is exactly the shape this passes straight through, so a caller building
// a PDF (invoicePdf.js) only needs to base64-encode the raw bytes once and
// hand them here, no format translation happening in two places.
// 2026-08-31: `returnId` added, default false — every existing caller
// (sendWelcomeEmail, sendPaymentFailedEmail, sendAddCardToContinueEmail,
// sendSupportEscalationEmail) keeps getting the plain boolean it always has,
// unchanged. Only sendInvoiceEmail passes `returnId: true`, since it's the
// one caller that now needs the Resend message id afterward (see
// resend-webhook.js): send-invoice.js stores it on the invoice row so an
// incoming Resend delivery webhook — delivered, bounced, complained — can be
// matched back to the right invoice and actually surfaced, instead of an
// invoice staying marked "Sent" forever regardless of what really happened
// to the email after Resend accepted it.
// 2026-08-31: `replyTo` added — every send in this file goes from the
// shared FROM_ADDRESS, so with nothing set here, hitting Reply on ANY
// email this app sends (not just invoices) went to annie@mail.meetannie.ai,
// an address nothing reads. Only sendInvoiceEmail actually passes one (the
// sending recruiter's own email) — that's the one email in the app whose
// own body text invites a reply ("Let us know if you have any questions"),
// so it's the one place that promise needs to actually be true. Every other
// caller is unaffected (undefined `reply_to` is simply omitted below, same
// as attachments).
export async function sendEmail({ to, subject, html, attachments, replyTo, returnId = false }) {
  const fail = () => (returnId ? { ok: false, id: null } : false)
  if (!process.env.RESEND_API_KEY) return fail() // not configured — silently a no-op, same as analytics.js with no key
  try {
    const resend = await loadResend()
    if (!resend) return fail()
    const { data, error } = await resend.emails.send({ from: FROM_ADDRESS, to, subject, html, ...(replyTo ? { reply_to: replyTo } : {}), ...(attachments?.length ? { attachments } : {}) })
    if (error) {
      console.error('[email] Resend rejected a send to', to, ':', error.message || error)
      return fail()
    }
    // 2026-08-31: log the Resend message id on every accepted send. This
    // function returning success only ever meant "Resend's API accepted the
    // request" — never "the recipient's inbox actually got it". Those are
    // different things: SPF/DKIM/DMARC can all be configured correctly (as
    // they are for mail.meetannie.ai) and a send can still be accepted by
    // Resend and then bounced, quarantined, or spam-foldered by the
    // receiving mail server after the fact. Previously `data` (which carries
    // that id) was discarded entirely, so a "the customer says they never
    // got it" report had no way to be looked up in Resend's own dashboard
    // (resend.com/emails). Now it's one Netlify function log away, and for
    // sendInvoiceEmail's callers it's also handed back directly.
    console.log('[email] Resend accepted send to', to, '— message id', data?.id)
    return returnId ? { ok: true, id: data?.id || null } : true
  } catch (err) {
    console.error('[email] send threw for', to, ':', err.message)
    return fail()
  }
}

// A small shared shell so every Annie email looks like it came from the
// same product, without a template engine — these are simple enough that
// hand-written strings stay easier to read and change than a build step.
function wrapEmail(bodyHtml) {
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;">
        <tr><td style="background:#0f1e3d;padding:24px 32px;">
          <span style="color:#ffffff;font-size:18px;font-weight:700;">Annie</span>
        </td></tr>
        <tr><td style="padding:32px;color:#1f2937;font-size:15px;line-height:1.6;">
          ${bodyHtml}
        </td></tr>
        <tr><td style="padding:20px 32px;background:#f9fafb;color:#9ca3af;font-size:12px;">
          Annie · Vantage Search Group ME DWC-LLC
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`
}

// Fired once, right after onboarding finishes (see save-onboarding.js) —
// deliberately not at signup, since at that point the account isn't set up
// yet and Supabase's own confirmation email has already gone out. This is
// the first email that's actually about Annie itself.
export async function sendWelcomeEmail(to, firmName) {
  return sendEmail({
    to,
    subject: 'Welcome to Annie',
    html: wrapEmail(`
      <p style="margin:0 0 16px;">Hi${firmName ? ` from ${firmName}` : ''},</p>
      <p style="margin:0 0 16px;">Annie's set up and already looking for signals in your market — new hires, funding rounds, job postings, the things that turn into conversations. Your first scan is running now; check your dashboard in a few minutes and it should already have something for you.</p>
      <p style="margin:0;">— The Annie team</p>
    `),
  })
}

// Fired from stripe-webhook.js's invoice.payment_failed handler. Stripe
// already runs its own dunning emails to the cardholder on Stripe's
// schedule — this is a second, Annie-branded notice pointed at the billing
// page, not a replacement for Stripe's retry emails.
export async function sendPaymentFailedEmail(to) {
  return sendEmail({
    to,
    subject: 'Action needed: your Annie payment failed',
    html: wrapEmail(`
      <p style="margin:0 0 16px;">We weren't able to charge your card for your Annie subscription.</p>
      <p style="margin:0 0 16px;">Nothing's been cancelled yet — Stripe will retry automatically, but if your card's expired or changed, updating it now avoids any interruption to your account.</p>
      <p style="margin:0;"><a href="https://app.meetannie.ai/dashboard/billing" style="color:#0f1e3d;font-weight:600;">Update billing details →</a></p>
    `),
  })
}

// 2026-08-25 — for the ANNIE100 free-month flow specifically (see
// start-trial-checkout.js): these accounts never had a card on file at
// all, so sendPaymentFailedEmail's "we weren't able to charge your card" /
// "if your card's expired or changed" copy would be actively wrong for
// them — there was never a card to fail or expire. stripe-webhook.js
// routes here instead of sendPaymentFailedEmail whenever it detects no
// default_payment_method on the subscription, whichever event triggered
// it (trial_will_end as an early heads-up, or invoice.payment_failed as
// the moment the free month actually runs out).
export async function sendAddCardToContinueEmail(to, { endingSoon = false } = {}) {
  return sendEmail({
    to,
    subject: endingSoon ? 'Your free month with Annie is ending soon' : 'Add a card to keep using Annie',
    html: wrapEmail(`
      <p style="margin:0 0 16px;">${endingSoon
        ? 'Your free month with Annie ends in a few days.'
        : 'Your free month with Annie has ended.'}</p>
      <p style="margin:0 0 16px;">Nothing else changes — same account, same data, same setup. Just add a card to keep it running.</p>
      <p style="margin:0;"><a href="https://app.meetannie.ai/dashboard/billing" style="color:#0f1e3d;font-weight:600;">Add a card →</a></p>
    `),
  })
}

// 2026-08-26 — the support widget (SupportWidget.jsx) can now recognise a
// handful of things it shouldn't try to resolve itself (a refund ask, a
// GDPR data request, a reproducible bug, someone asking for a human) and
// flags them via support-escalate.js. There's no ticketing system yet — per
// Michael's own call, this goes straight to his inbox in real time rather
// than only surfacing later in the admin Insights page, since he's the
// entire support team right now. ESCALATION_LABELS mirrors the category
// list in src/lib/supportEscalation.js (kept as a plain duplicate constant,
// not a shared import — frontend and Netlify functions don't share modules
// anywhere else in this codebase, see chat.js/callChat.js's own separation).
const ESCALATION_LABELS = {
  refund_billing: 'Refund / billing dispute',
  gdpr_data_request: 'Data export or deletion request',
  bug_report: 'Possible bug report',
  human_requested: 'Customer asked for a human',
  unresolved: 'Unresolved after repeated attempts',
}

export async function sendSupportEscalationEmail(to, { customerEmail, firmName, category, excerpt }) {
  const label = ESCALATION_LABELS[category] || ESCALATION_LABELS.unresolved
  return sendEmail({
    to,
    subject: `Annie support: ${label}${firmName ? ` — ${firmName}` : ''}`,
    html: wrapEmail(`
      <p style="margin:0 0 16px;"><strong>${label}</strong></p>
      <p style="margin:0 0 16px;">${firmName ? `${firmName} · ` : ''}${customerEmail || 'unknown customer'}</p>
      <div style="margin:0 0 16px;padding:16px;background:#f9fafb;border-radius:8px;white-space:pre-wrap;font-size:14px;color:#374151;">${excerpt || '(no conversation excerpt captured)'}</div>
      <p style="margin:0;color:#6b7280;font-size:13px;">Flagged automatically by Annie support — no reply has been sent to the customer about this yet.</p>
    `),
  })
}

// 2026-08-26 — send-invoice.js's outgoing email to the recruiter's own
// client, with the generated PDF attached. Deliberately plain and short —
// this is a business-to-business invoice email, not a marketing email; the
// PDF itself carries every real detail (line items, bank details, totals).
// senderName/firmName come from the sending recruiter's own profile/team,
// not from Annie, since this email is from them to their client — Annie's
// branding stays limited to the footer, same as every other email here.
// 2026-08-31: return shape changed from a plain boolean to { sent,
// resendEmailId } — this is the one email in the app that goes to someone
// outside the recruiter's own account (their client), so it's the one case
// where "did the API accept it" isn't a good enough answer on its own. See
// sendEmail's own header for why every other caller is unaffected.
// senderEmail — 2026-08-31 audit fix: the recruiter's own login email
// (send-invoice.js passes the authed user's own `user.email`), set as
// reply_to so a client's "just hit reply with a question" actually reaches
// the person who sent it, not annie@mail.meetannie.ai. Optional rather than
// required so a genuinely missing email (shouldn't happen for an
// authenticated user, but never worth failing a real invoice send over)
// degrades to "no reply-to set" rather than blocking the send.
export async function sendInvoiceEmail(to, { firmName, senderName, senderEmail, invoiceNumber, total, currency, dueDate, pdfBase64, pdfFilename }) {
  const { ok, id } = await sendEmail({
    to,
    subject: `Invoice ${invoiceNumber}${firmName ? ` from ${firmName}` : ''}`,
    html: wrapEmail(`
      <p style="margin:0 0 16px;">Hi,</p>
      <p style="margin:0 0 16px;">Please find invoice <strong>${invoiceNumber}</strong> attached${firmName ? ` from ${firmName}` : ''}, for <strong>${currency} ${total}</strong>${dueDate ? `, due ${dueDate}` : ''}.</p>
      <p style="margin:0 0 16px;">Payment details are on the invoice itself. Let us know if you have any questions.</p>
      <p style="margin:0;">${senderName || 'Thanks'}</p>
    `),
    attachments: [{ filename: pdfFilename, content: pdfBase64 }],
    replyTo: senderEmail || undefined,
    returnId: true,
  })
  return { sent: ok, resendEmailId: id }
}
