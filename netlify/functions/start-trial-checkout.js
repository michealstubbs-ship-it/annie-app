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
      // Lets a 100%-off code (annie100) skip card collection entirely —
      // Stripe only asks for a payment method if the order actually needs
      // one after any promo code is applied.
      payment_method_collection: 'if_required',
      success_url: `${appUrl}/welcome?checkout=success`,
      cancel_url: `${marketingUrl}/#pricing`,
      subscription_data: {
        metadata: { tier, source: 'marketing_site_signup' },
        trial_period_days: 7,
      },
    })

    return new Response(null, { status: 302, headers: { Location: session.url } })
  } catch (err) {
    console.error('[start-trial-checkout] failed:', err.message)
    return new Response('Could not start checkout', { status: 500 })
  }
}

export const config = { path: '/api/start-trial-checkout' }
