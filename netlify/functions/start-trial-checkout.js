// Entry point for meetannie.ai's marketing-site "Start free trial" buttons.
// Unlike stripe-checkout.js (which requires an already-logged-in Annie
// user), this runs BEFORE any Annie account exists — a visitor picks a
// plan on the public pricing page and lands here with just a tier+interval,
// no session. Stripe Checkout collects their email and card itself; the
// Annie account is created afterward, in stripe-webhook.js's
// checkout.session.completed handler, once payment is confirmed. This is a
// plain GET+redirect (not a fetch) so a bare marketing-site <a href> works
// with zero JS.
import Stripe from 'stripe'
import { priceIdFor } from './lib/stripeShared.js'

const TEAM_MIN_SEATS = 3
const VALID_TIERS = ['starter', 'growth', 'team']

// 2026-08-25, per Michael — simplified deliberately, replacing an earlier
// version that depended on a live Stripe promotion code/coupon existing
// (which broke silently the day that coupon didn't actually exist in live
// Stripe — see the incident this replaced). ANNIE100 is now just a literal
// code checked in this file, no Stripe object required to keep it working:
//   - a normal signup gets a real card collected up front and the standard
//     7-day trial, same as always.
//   - `?code=annie100` (case-insensitive — Michael types it in caps) skips
//     the card entirely and gets a 30-day trial instead of 7 — a genuine
//     free month, no strings attached at signup.
// The only way anyone gets this is a link Michael hands out directly —
// there's no self-serve box for it anywhere, so that act of sending the
// link out IS the approval step, deliberately, rather than building an
// actual approval workflow Stripe has no native way to support.
// When the 30-day trial ends with no card on file, Stripe itself creates
// an invoice, that invoice fails to charge (no payment method), and
// stripe-webhook.js's invoice.payment_failed / trial_will_end handlers
// send the customer an email pointed at the billing portal — same account,
// same data, they're just adding a card, never a new signup.
const FREE_MONTH_CODE = 'annie100'
const DEFAULT_TRIAL_DAYS = 7
const FREE_MONTH_TRIAL_DAYS = 30

export default async (req) => {
  const stripeKey = process.env.STRIPE_SECRET_KEY
  const appUrl = process.env.APP_URL || 'https://app.meetannie.ai'
  const marketingUrl = process.env.MARKETING_URL || 'https://meetannie.ai'

  if (!stripeKey) {
    return new Response('Billing is not configured yet', { status: 503 })
  }

  const url = new URL(req.url)
  const tier = url.searchParams.get('tier')
  const interval = url.searchParams.get('interval') === 'year' ? 'year' : 'month'
  const isFreeMonth = (url.searchParams.get('code') || '').trim().toLowerCase() === FREE_MONTH_CODE

  if (!VALID_TIERS.includes(tier)) {
    return new Response(`Unknown plan: ${tier}`, { status: 400 })
  }

  const priceId = priceIdFor(tier, interval)
  if (!priceId) {
    return new Response(`Unconfigured plan: ${tier}/${interval}`, { status: 400 })
  }

  const stripe = new Stripe(stripeKey)

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{
        price: priceId,
        quantity: tier === 'team' ? TEAM_MIN_SEATS : 1,
        ...(tier === 'team' ? { adjustable_quantity: { enabled: true, minimum: TEAM_MIN_SEATS, maximum: 100 } } : {}),
      }],
      allow_promotion_codes: true,
      // 'if_required' only skips the card because a trial alone already
      // makes today's total $0 — true for every signup, not just the free-
      // month one. Only the free-month link is allowed to skip it; a
      // normal signup always collects a card up front on purpose (the
      // actual "trial, then auto-charge unless cancelled" pattern).
      payment_method_collection: isFreeMonth ? 'if_required' : 'always',
      success_url: `${appUrl}/welcome?checkout=success`,
      cancel_url: `${marketingUrl}/#pricing`,
      subscription_data: {
        metadata: { tier, source: 'marketing_site_signup', ...(isFreeMonth ? { free_month_code: FREE_MONTH_CODE } : {}) },
        trial_period_days: isFreeMonth ? FREE_MONTH_TRIAL_DAYS : DEFAULT_TRIAL_DAYS,
      },
    })

    return new Response(null, { status: 302, headers: { Location: session.url } })
  } catch (err) {
    console.error('[start-trial-checkout] failed:', err.message)
    return new Response('Could not start checkout', { status: 500 })
  }
}

export const config = { path: '/api/start-trial-checkout' }
