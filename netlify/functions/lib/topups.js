// Contact-credit top-up packs.
//
// Pricing decided with Michael on 2026-09-04, and the governing constraint is
// NOT the cost of a credit — it is that a top-up must never be cheaper per
// credit than upgrading, or the upgrade path dies.
//
//   Starter $79 (50/mo)  ->  Growth $129 (150/mo)
//   = +$50 for +100 credits = $0.50 a credit, AND unlimited Ask Annie,
//     AND deeper scans.
//
// So every pack below prices ABOVE $0.50. Buying 100 credits as top-ups costs
// $80-100 against $50 to upgrade and get more product with it. That is
// deliberate: the top-up is the expensive convenience option, and its job is to
// make the upgrade look like the sensible one.
//
// Cost side: Apollo's own overage rate is $0.20 a credit (250 minimum), which
// is the worst case — inside the plan allowance it is less. One delivered
// contact is one credit, because searches and failed reveals are free
// (verified against the live API, 2026-09-04). Margin therefore runs 71-80%.
//
// Never hardcode a Stripe price ID — test mode and live mode have different
// IDs for the same nominal price, same reasoning as PRICE_ENV_VARS in
// stripeShared.js.
export const TOPUP_PACKS = [
  { key: 'small', credits: 25, priceUsd: 25, envVar: 'STRIPE_PRICE_TOPUP_25' },
  { key: 'medium', credits: 75, priceUsd: 60, envVar: 'STRIPE_PRICE_TOPUP_75' },
  { key: 'large', credits: 200, priceUsd: 140, envVar: 'STRIPE_PRICE_TOPUP_200' },
]

export function packByKey(key) {
  return TOPUP_PACKS.find(p => p.key === key) || null
}

export function topupPriceId(key) {
  const pack = packByKey(key)
  return pack ? process.env[pack.envVar] || null : null
}

// Reverse lookup for the webhook: Stripe reports the price ID that was bought,
// and that is the one thing guaranteed to stay accurate — metadata captured at
// checkout can go stale, a price ID cannot.
export function packFromPriceId(priceId) {
  if (!priceId) return null
  return TOPUP_PACKS.find(p => process.env[p.envVar] === priceId) || null
}

// What the UI shows. Deliberately computed rather than written twice, so the
// per-credit figure can never drift from the price it is derived from.
export function packsForDisplay() {
  return TOPUP_PACKS.map(p => ({
    key: p.key,
    credits: p.credits,
    priceUsd: p.priceUsd,
    perCredit: Math.round((p.priceUsd / p.credits) * 100) / 100,
    configured: !!process.env[p.envVar],
  }))
}
