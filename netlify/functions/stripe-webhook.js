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
import { sendPaymentFailedEmail, sendAddCardToContinueEmail } from './lib/email.js'
import { createTimeoutFetch } from './lib/scanShared.js'

// Pulls the fields subscriptions actually needs off a Stripe Subscription
// object, resolving tier/interval from the live price ID rather than any
// metadata that could have gone stale — see stripeShared.js for why.
// free_month_code IS trusted from metadata (unlike tier/interval) — it's
// only ever set by start-trial-checkout.js itself, at session-creation
// time, never user-editable input, and it's what lets that endpoint count
// real redemptions against its cap (see its own header).
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
    free_month_code: sub.metadata?.free_month_code || null,
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

  // 2026-08-24 Task 3: createTimeoutFetch applied — see its own header in
  // scanShared.js.
  const supabase = createClient(supabaseUrl, serviceKey, { global: { fetch: createTimeoutFetch() } })

  // Stripe can and does redeliver the same event (network retries, a manual
  // resend from the dashboard). The subscriptions writes below are already
  // idempotent-safe via onConflict, but invoice.payment_failed's email send
  // is not — a redelivered event would re-send "your payment failed" to a
  // customer who already got it once. Reserving event.id here (before any
  // handling runs) makes the WHOLE handler idempotent, not just that one
  // branch.
  //
  // 2026-08-26 audit fix: this used to be a plain SELECT check here, with
  // the event_id only INSERTed at the very end, on the success path. That
  // left a real TOCTOU window — if Stripe genuinely redelivers the same
  // event close enough in time that the second delivery's SELECT runs
  // before the first delivery's end-of-handler INSERT, both proceed, and
  // for invoice.payment_failed/trial_will_end that means a duplicate
  // customer email with no guard (unlike the subscriptions writes, which
  // are protected by onConflict). event_id is this table's PRIMARY KEY, so
  // reserving it via a single INSERT is atomic: a concurrent duplicate
  // hits a real unique-violation instead of a race, and this is treated
  // exactly like "already processed" — same external behaviour, no gap.
  const { error: reserveError } = await supabase.from('stripe_webhook_events').insert({ event_id: event.id, event_type: event.type })
  if (reserveError) {
    if (reserveError.code === '23505') {
      return new Response('ok (already processed)', { status: 200 })
    }
    await reportServerError('stripe-webhook', new Error(`event reservation failed: ${reserveError.message}`), { eventType: event.type, eventId: event.id })
    return new Response('Webhook handler error', { status: 500 })
  }

  try {
    switch (event.type) {
      // First checkout completion — the one moment we have client_reference_id
      // (the Supabase user_id set in stripe-checkout.js) directly on the
      // event, so this is where the subscriptions row is first created and
      // tied to a real Annie account. Every later event (plan changes,
      // renewals, cancellations) updates that same row keyed by
      // stripe_customer_id / stripe_subscription_id instead.
      // 2026-08-24: start-trial-checkout.js (the marketing site's
      // "Start free trial" buttons) has no logged-in user to set
      // client_reference_id from — checkout itself collects the buyer's
      // email. When that's the case, resolve or CREATE the Annie account
      // right here: look up an existing profile by email first (covers an
      // existing customer buying a second time from the marketing site),
      // else invite a brand-new one. inviteUserByEmail creates the
      // auth.users row, which fires handle_new_user() synchronously —
      // that's what bootstraps the profiles row and the personal
      // team/team_members row this handler needs below, exactly the same
      // as a normal in-app signup.
      case 'checkout.session.completed': {
        const session = event.data.object
        if (!session.subscription) break
        let userId = session.client_reference_id
        if (!userId) {
          const email = session.customer_details?.email || session.customer_email
          if (!email) throw new Error('checkout.session.completed has no client_reference_id and no email to resolve a user from')

          const { data: existingProfile } = await supabase.from('profiles').select('id').ilike('email', email).maybeSingle()
          if (existingProfile) {
            userId = existingProfile.id
          } else {
            const appUrl = process.env.APP_URL || 'https://app.meetannie.ai'
            // Stripe Checkout already collected their name as part of card
            // entry (session.customer_details.name) -- pass it through as
            // user_metadata so handle_new_user() picks it up the same way a
            // normal in-app signup's full_name does, instead of leaving new
            // marketing-site customers with a blank profile name.
            const { data: invited, error: inviteErr } = await supabase.auth.admin.inviteUserByEmail(email, {
              redirectTo: `${appUrl}/reset-password`,
              data: session.customer_details?.name ? { full_name: session.customer_details.name } : undefined,
            })
            if (inviteErr) throw new Error(`could not create account for ${email}: ${inviteErr.message}`)
            userId = invited.user.id
          }
        }
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
        // 2026-08-26 audit fix: this used to assume a zero-row match set
        // `error`, so it could fall back to matching by customer id — that
        // premise is false. PostgREST/Postgres don't error on an UPDATE
        // that matches zero rows (only a genuine query failure sets
        // `error`), so the "no matching row yet, fall back" comment
        // described a path the code couldn't actually reach: any case
        // where the subscription_id match legitimately misses (e.g. this
        // event races ahead of checkout.session.completed) silently
        // dropped the update entirely, with no fallback, no log, nothing.
        // `.select('id')` on the update surfaces the real "did anything
        // match" signal so the fallback can actually run when it's needed.
        const { data, error } = await supabase
          .from('subscriptions')
          .update(fieldsFromSubscription(sub))
          .eq('stripe_subscription_id', sub.id)
          .select('id')
        if (error) throw new Error(`subscription update by stripe_subscription_id failed: ${error.message}`)
        if (!data || data.length === 0) {
          const { data: fallbackData, error: fallbackError } = await supabase
            .from('subscriptions')
            .update(fieldsFromSubscription(sub))
            .eq('stripe_customer_id', sub.customer)
            .select('id')
          if (fallbackError) throw new Error(`subscription update by stripe_customer_id failed: ${fallbackError.message}`)
          if (!fallbackData || fallbackData.length === 0) {
            // Genuinely no row matched either way — most likely this event
            // raced ahead of checkout.session.completed, which will create
            // the row and a later event will reconcile it. Logged (not
            // thrown) since this is an expected, recoverable ordering
            // case, not a failure — but now at least visible instead of
            // silent.
            console.error('[stripe-webhook] no subscriptions row matched for', sub.id, sub.customer, '— expected if checkout.session.completed hasn\'t landed yet, otherwise worth a look')
          }
        }
        break
      }

      // Failed renewal charge. Stripe already retries and emails the
      // customer on its own dunning schedule — the console.error here is
      // for Annie's own ops visibility (mirrors alertIfConfigured in
      // scanShared.js), and sendPaymentFailedEmail is a second,
      // Annie-branded notice pointed at the billing page — not a
      // replacement for Stripe's own dunning emails, a supplement to them.
      //
      // 2026-08-25: this also fires for the ANNIE100 free-month flow the
      // moment its 30-day trial ends with no card on file — Stripe still
      // creates an invoice (trial_settings.end_behavior.missing_payment_
      // method defaults to 'create_invoice'), which then fails to charge
      // immediately since there's nothing to charge. sendPaymentFailedEmail
      // ("we weren't able to charge your card") would be wrong for that
      // case — there was never a card — so this checks whether the
      // subscription actually has a payment method on file and routes to
      // sendAddCardToContinueEmail instead when it doesn't.
      case 'invoice.payment_failed': {
        const invoice = event.data.object
        console.error('[stripe-webhook] payment failed for customer', invoice.customer, 'invoice', invoice.id)
        if (invoice.customer_email) {
          let hasPaymentMethod = true
          try {
            const subId = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id
            if (subId) {
              const sub = await stripe.subscriptions.retrieve(subId)
              hasPaymentMethod = !!sub.default_payment_method
            }
          } catch (err) {
            console.error('[stripe-webhook] could not check payment method for', invoice.customer, ':', err.message)
          }
          const send = hasPaymentMethod
            ? sendPaymentFailedEmail(invoice.customer_email)
            : sendAddCardToContinueEmail(invoice.customer_email, { endingSoon: false })
          send.catch(() => {})
        }
        break
      }

      // 2026-08-25 — fires 3 days before ANY trial ends, including the
      // normal 7-day one, but only actionable for the ANNIE100 free-month
      // flow: a normal signup already collected a card up front, so their
      // trial ending just auto-charges on schedule, nothing for the
      // customer to do and no email sent here for them. Only a subscription
      // with no default_payment_method (the free-month flow, by design —
      // see start-trial-checkout.js) gets this early heads-up before
      // invoice.payment_failed becomes the same message after the fact.
      case 'customer.subscription.trial_will_end': {
        const sub = event.data.object
        if (sub.default_payment_method) break
        try {
          const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id
          const customer = await stripe.customers.retrieve(customerId)
          if (customer && !customer.deleted && customer.email) {
            sendAddCardToContinueEmail(customer.email, { endingSoon: true }).catch(() => {})
          }
        } catch (err) {
          console.error('[stripe-webhook] trial_will_end email lookup failed for', sub.customer, ':', err.message)
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
    //
    // 2026-08-26: the event_id reservation now happens BEFORE handling (see
    // above), so a failed attempt needs to explicitly release it — without
    // this delete, Stripe's retry (a fresh delivery of the same event.id)
    // would hit the unique-violation "already processed" path above and
    // never actually get a real second attempt.
    await supabase.from('stripe_webhook_events').delete().eq('event_id', event.id).then(() => {}, () => {})
    return new Response('Webhook handler error', { status: 500 })
  }

  return new Response('ok', { status: 200 })
}

export const config = { path: '/api/stripe-webhook' }
