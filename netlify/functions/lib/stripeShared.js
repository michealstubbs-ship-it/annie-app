// Shared between stripe-checkout.js (which needs to look up a price ID
// FROM a tier+interval) and stripe-webhook.js (which needs the reverse:
// given a price ID Stripe reports on a subscription, which tier is that).
// One mapping, defined once, so the two can never drift out of sync with
// each other.

// tier/interval -> the Netlify env var holding that Stripe Price ID. Never
// hardcode a price ID directly — it's environment-specific (test mode vs
// live mode have different IDs for the same nominal price).
export const PRICE_ENV_VARS = {
  starter: { month: 'STRIPE_PRICE_STARTER_MONTHLY', year: 'STRIPE_PRICE_STARTER_YEARLY' },
  growth: { month: 'STRIPE_PRICE_GROWTH_MONTHLY', year: 'STRIPE_PRICE_GROWTH_YEARLY' },
  team: { month: 'STRIPE_PRICE_TEAM_MONTHLY', year: 'STRIPE_PRICE_TEAM_YEARLY' },
}

export function priceIdFor(tier, interval) {
  const envVar = PRICE_ENV_VARS[tier]?.[interval]
  return envVar ? process.env[envVar] : null
}

// Reverse lookup: given a Stripe price ID (as reported live on a
// subscription object), which tier/interval is it. Deliberately reads the
// price ID off the subscription itself rather than trusting the
// subscription_data.metadata set at checkout time — metadata set once at
// checkout goes stale the moment a customer changes plans through Stripe's
// own hosted Customer Portal (stripe-portal.js), which updates the price
// but has no reason to also rewrite Annie's metadata. The price ID is the
// one thing Stripe guarantees stays accurate.
export function resolveTierFromPriceId(priceId) {
  if (!priceId) return { tier: null, interval: null }
  for (const [tier, intervals] of Object.entries(PRICE_ENV_VARS)) {
    for (const [interval, envVar] of Object.entries(intervals)) {
      if (process.env[envVar] === priceId) return { tier, interval }
    }
  }
  return { tier: null, interval: null }
}
