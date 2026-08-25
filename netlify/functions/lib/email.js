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
export async function sendEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) return false // not configured — silently a no-op, same as analytics.js with no key
  try {
    const resend = await loadResend()
    if (!resend) return false
    const { error } = await resend.emails.send({ from: FROM_ADDRESS, to, subject, html })
    return !error
  } catch {
    return false
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
