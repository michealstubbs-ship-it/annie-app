// The only writer of public.subscriptions. Stripe calls this directly (not
// the browser, not stripe-checkout.js) whenever a subscription is created,
// changed, or cancelled — so Annie's own idea of "is this customer active"
// stays a faithful mirror of what Stripe actually has on file, not
// something the checkout flow guesses at the moment a session starts.
//
// Every event is verified against STRIPE_WEBHOOK_SECRET before anything in
// its payload is trusted — this endpoint is public by necessity (Stripe's
// servers call it directly, no user session exists), so signature
// verification is the ONLY thing standing between this and anyone POSTing
// a fake "subscription activated" event for a free account. Never skip it,
// even to make local testing easier.
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import { reportServerError } from './lib/reportError.js'
import { resolveTierFromPriceId } from './lib/stripeShared.js'
import { sendPaymentFailedEmail } from './lib/email.js'

// Pulls the fields subscriptions actually needs off a Stripe Subscription
// object, resolving tier/interval from the live price ID rather than any
// metadata that could have gone stale — see stripeShared.js for why.
function fieldsFromSubscription(sub) {
  const item = sub.items?.data?.[0]
  const { tier, interval } = resolveTierFromPriceId(item?.price?.id)
  return {
    stripe_subscription_id: sub.id,
    stripe_customer_id: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id,
    tier,
    status: sub.status,
    billing_interval: interval,
    seats: item?.quantity || 1,
    current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
    cancel_at_period_end: !!sub.cancel_at_period_end,
    updated_at: new Date().toISOString(),
  }
}

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!stripeKey || !webhookSecret || !supabaseUrl || !serviceKey) {
    // Not configured yet — 200 so Stripe doesn't spend its retry budget on
    // an endpoint that isn't ready, but nothing here is trusted or acted on.
    return new Response('Not configured', { status: 200 })
  }

  const stripe = new Stripe(stripeKey)
  const signature = req.headers.get('stripe-signature')
  const rawBody = await req.text()

  let event
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret)
  } catch (err) {
    console.error('[stripe-webhook] signature verification failed:', err.message)
    return new Response('Invalid signature', { status: 400 })
  }

  const supabase = createClient(supabaseUrl, serviceKey)

  // Stripe can and does redeliver the same event (network retries, a manual
  // resend from the dashboard). The subscriptions writes below are already
  // idempotent-safe via onConflict, but invoice.payment_failed's email send
  // is not — a redelivered event would re-send "your payment failed" to a
  // customer who already got it once. Recording event.id here makes the
  // WHOLE handler idempotent, not just that one branch.
  const { data: already } = await supabase.from('stripe_webhook_events').select('event_id').eq('event_id', event.id).maybeSingle()
  if (already) {
    return new Response('ok (already processed)', { status: 200 })
  }

  try {
    switch (event.type) {
      // First checkout completion — the one moment we have client_reference_id
      // (the Supabase user_id set in stripe-checkout.js) directly on the
      // event, so this is where the subscriptions row is first created and
      // tied to a real Annie account. Every later event (plan changes,
      // renewals, cancellations) updates that same row keyed by
      // stripe_customer_id / stripe_subscription_id instead.
      case 'checkout.session.completed': {
        const session = event.data.object
        const userId = session.client_reference_id
        if (!userId || !session.subscription) break
        const sub = await stripe.subscriptions.retrieve(session.subscription)
        // Every account has an active team from the moment it signs up
        // (see handle_new_user() in the 2026-08-24 migration) — this looks
        // that team up rather than trusting anything Stripe echoed back, so
        // a subscription always lands against whichever team the buyer is
        // actually on right now, not a stale guess captured at checkout
        // time. A subscription belongs to a team, not to one member, so
        // every teammate's tier/seat lookup (entitlements.js) resolves off
        // this same team_id.
        const { data: membership } = await supabase.from('team_members').select('team_id').eq('user_id', userId).eq('status', 'active').maybeSingle()
        if (!membership) throw new Error(`no active team found for user ${userId} at checkout completion`)
        // Same unchecked-write bug that caused the intelligence_signals
        // incident, found here during the follow-up sweep: this upsert's
        // `error` was never checked. The columns happen to match live right
        // now, so this hasn't silently failed the same way yet — but a
        // customer who pays and gets no subscription row (RLS hiccup, a
        // future schema change, a transient DB error) deserves better than
        // a 200 to Stripe and no trace anywhere. Throwing here routes it
        // into the same catch below that already reports it and tells
        // Stripe to retry.
        const { error } = await supabase.from('subscriptions').upsert({
          user_id: userId,
          team_id: membership.team_id,
          ...fieldsFromSubscription(sub),
        }, { onConflict: 'user_id' })
        if (error) throw new Error(`subscription upsert failed: ${error.message}`)
        break
      }

      // Plan changes, renewals, and Stripe's own dunning process (e.g.
      // status flipping to past_due after a failed card charge) all land
      // here as the same event type — the subscription object's current
      // `status` is the single source of truth, this just re-syncs it.
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object
        const { error } = await supabase
          .from('subscriptions')
          .update(fieldsFromSubscription(sub))
          .eq('stripe_subscription_id', sub.id)
        if (error) {
          // No matching row yet (e.g. this event raced ahead of
          // checkout.session.completed) — fall back to matching on
          // customer id, or give up quietly rather than throw, since a
          // later event will reconcile the row anyway.
          await supabase.from('subscriptions').update(fieldsFromSubscription(sub)).eq('stripe_customer_id', sub.customer)
        }
        break
      }

      // Failed renewal charge. Stripe already retries and emails the
      // customer on its own dunning schedule — the console.error here is
      // for Annie's own ops visibility (mirrors alertIfConfigured in
      // scanShared.js), and sendPaymentFailedEmail is a second,
      // Annie-branded notice pointed at the billing page — not a
      // replacement for Stripe's own dunning emails, a supplement to them.
      case 'invoice.payment_failed': {
        const invoice = event.data.object
        console.error('[stripe-webhook] payment failed for customer', invoice.customer, 'invoice', invoice.id)
        if (invoice.customer_email) {
          sendPaymentFailedEmail(invoice.customer_email).catch(() => {})
        }
        break
      }

      default:
        // Unhandled event types are expected and fine — Stripe sends many
        // more event types than this endpoint needs to react to.
        break
    }
  } catch (err) {
    console.error('[stripe-webhook] failed handling', event.type, err.message)
    await reportServerError('stripe-webhook', err, { eventType: event.type, eventId: event.id })
    // A production-readiness audit (2026-08-22) found this always returned
    // 200 even here — meaning the checkout.session.completed comment above
    // ("throwing here... tells Stripe to retry") was describing intended
    // behavior the code didn't actually implement: Stripe only retries on a
    // non-2xx response, so a paying customer whose subscription upsert
    // failed got a 200 back regardless, no retry ever happened, and
    // error_logs was the only trace — nobody would recover that customer's
    // subscription row without a human noticing the log first. A 500 here
    // makes Stripe actually retry (its own delivery is idempotent-safe for
    // every case this file handles — see fieldsFromSubscription's onConflict
    // usage), which is strictly better recovery than relying on a human to
    // read error_logs before the customer notices anything's wrong.
    return new Response('Webhook handler error', { status: 500 })
  }

  // Only recorded on the success path — a failed attempt returns 500 above
  // without reaching here, so Stripe's retry actually gets a fresh attempt
  // instead of being silently marked "already processed."
  await supabase.from('stripe_webhook_events').insert({ event_id: event.id, event_type: event.type }).then(() => {}, () => {})

  return new Response('ok', { status: 200 })
}

export const config = { path: '/api/stripe-webhook' }
