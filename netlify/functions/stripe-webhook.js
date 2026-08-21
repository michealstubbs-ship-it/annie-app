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
        await supabase.from('subscriptions').upsert({
          user_id: userId,
          ...fieldsFromSubscription(sub),
        }, { onConflict: 'user_id' })
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
      // customer on its own dunning schedule — this alert is for Annie's
      // own ops visibility (mirrors alertIfConfigured in scanShared.js),
      // not a substitute for Stripe's customer-facing dunning flow.
      case 'invoice.payment_failed': {
        const invoice = event.data.object
        console.error('[stripe-webhook] payment failed for customer', invoice.customer, 'invoice', invoice.id)
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
    // Still 200: a 4xx/5xx here makes Stripe retry, which is right for a
    // transient DB hiccup, but reportServerError already gives ops a real
    // trace to act on rather than silently losing the event to retries
    // that could eventually exhaust and drop it.
  }

  return new Response('ok', { status: 200 })
}

export const config = { path: '/api/stripe-webhook' }
