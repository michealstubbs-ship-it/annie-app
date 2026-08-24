// Starts a Stripe Checkout session for a logged-in customer choosing (or
// changing) a plan. Self-serve only, by design — see Annie-Pricing-
// Strategy.md for why: Stripe's own hosted Checkout page handles card
// entry, 3DS, and validation, so nothing here ever touches a card number
// or payment credential directly, only a Stripe-generated session URL the
// browser is redirected to.
//
// Same auth pattern as chat.js and scan-now-background.js: identify the
// caller from their OWN Supabase session token, never trust a user id from
// the request body — otherwise anyone could start (or worse, silently
// attribute) a checkout for a different customer's account.
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import { reportServerError } from './lib/reportError.js'
import { priceIdFor } from './lib/stripeShared.js'
import { getAuthedUser } from './lib/auth.js'
import { createTimeoutFetch } from './lib/scanShared.js'

// Team is sold with a 3-seat minimum (mirrors how Apollo structures its own
// Organization tier) — Checkout starts at that quantity and lets the buyer
// adjust upward, never below the minimum, right on the hosted page.
const TEAM_MIN_SEATS = 3

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY
  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const appUrl = process.env.APP_URL || 'https://app.meetannie.ai'

  if (!stripeKey || !supabaseUrl || !anonKey || !serviceKey) {
    return new Response(JSON.stringify({ error: 'Billing is not configured yet' }), { status: 503, headers: { 'Content-Type': 'application/json' } })
  }

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

  const tier = body.tier
  const interval = body.interval === 'year' ? 'year' : 'month'
  const priceId = priceIdFor(tier, interval)
  if (!priceId) {
    return new Response(JSON.stringify({ error: `Unknown or unconfigured plan: ${tier}/${interval}` }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }

  const stripe = new Stripe(stripeKey)
  // 2026-08-24 Task 3: createTimeoutFetch applied — see its own header in
  // scanShared.js.
  const supabase = createClient(supabaseUrl, serviceKey, { global: { fetch: createTimeoutFetch() } })

  try {
    // Reuse an existing Stripe customer if this user already has one on
    // file (e.g. they cancelled and are resubscribing), instead of Stripe
    // silently creating duplicate customer records for the same person on
    // every checkout attempt. This same row also decides trial eligibility
    // below — a returning row (any tier, any past status) means they've
    // already had a subscription before, trial or paid.
    const { data: existingSub } = await supabase
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', user.id)
      .maybeSingle()

    let customerId = existingSub?.stripe_customer_id
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { supabase_user_id: user.id },
      })
      customerId = customer.id
    }

    // 7-day free trial, first subscription only. Gating on "has a
    // subscriptions row at all" (not on its current status) closes the
    // obvious abuse path — cancel during the trial, then start a fresh
    // checkout for another free 7 days — without needing Stripe's own
    // trial-abuse settings. A genuinely returning customer (they cancelled
    // months ago, now want back in) pays from day one on their new
    // subscription, same as any competitor's "one trial per customer"
    // policy.
    const trialEligible = !existingSub

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: user.id,
      line_items: [{
        price: priceId,
        quantity: tier === 'team' ? TEAM_MIN_SEATS : 1,
        ...(tier === 'team' ? { adjustable_quantity: { enabled: true, minimum: TEAM_MIN_SEATS, maximum: 100 } } : {}),
      }],
      allow_promotion_codes: true,
      success_url: `${appUrl}/dashboard/billing?checkout=success`,
      cancel_url: `${appUrl}/dashboard/billing?checkout=cancelled`,
      subscription_data: {
        metadata: { supabase_user_id: user.id, tier },
        ...(trialEligible ? { trial_period_days: 7 } : {}),
      },
    })

    return new Response(JSON.stringify({ url: session.url }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    await reportServerError('stripe-checkout', err, { userId: user.id, tier, interval })
    return new Response(JSON.stringify({ error: 'Could not start checkout' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
}

export const config = { path: '/api/stripe-checkout' }
