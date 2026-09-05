// The one place tier pricing/display copy lives. Originally kept private to
// Billing.jsx (see its old comment: "the ONLY thing that has to match the
// backend exactly is the tier key") — moved out here 2026-08-24 because the
// admin operator dashboard needs the same dollar amounts to compute MRR
// from raw subscription rows, and duplicating these numbers in a second
// place is exactly the kind of drift this session has been closing all
// along (the scan-prompt fork in finding 3.6, the RACY_TYPES fork in
// signalTypes.js). The tier key ('starter' / 'growth' / 'team') is still
// the only thing that has to match the backend exactly — stripe-checkout.js
// maps it to a real Stripe Price ID via env vars — everything else here
// (price shown, description, feature list) is display copy, safe to tune.
// See Annie-Pricing-Strategy.md for how these numbers were arrived at —
// treat them as the working proposal, not a locked-in final price.
//
// `monthly` and `yearly` are both already expressed as an effective
// $/month figure (yearly billing is cheaper per month, not per year) — any
// consumer computing revenue should use these directly, never multiply
// `yearly` by 12.
// 2026-09-05: three tiers became two. Starter is gone and Growth is Solo.
//
// Starter was removed rather than repriced because under the network-first
// product the mailbox is the engine — dormancy, relationship strength and
// last-contacted all come from email sync, which Starter never had. Selling a
// plan that structurally cannot do what the page promises is the failure this
// whole release exists to end.
//
// Solo keeps Growth's price and Growth's Stripe prices; only the name and the
// feature copy changed. The tier key ('solo' / 'team') is still the only thing
// that has to match the backend exactly — stripeShared.js maps it to a real
// Stripe Price ID via env vars — everything else here is display copy.
//
// `monthly` and `yearly` are both already expressed as an effective $/month
// figure (yearly billing is cheaper per month, not per year) — any consumer
// computing revenue should use these directly, never multiply `yearly` by 12.
export const TIERS = [
  {
    key: 'solo',
    name: 'Solo',
    blurb: 'For one recruiter and the network they already have.',
    monthly: 129,
    yearly: 109,
    // Every bullet here has to be something the product demonstrably does. The
    // contact-lookup line says "lookups" rather than "contacts": Apollo charges
    // when it matches a PERSON, and roughly half of those carry no email
    // (measured against the live API on a real network, 2026-09-05). The
    // earlier wording promised 150 contacts received and could not honour it.
    features: [
      'Full CRM, pipeline and contacts',
      'Your network ranked into a daily call list',
      'Job moves and promotions detected from your LinkedIn export',
      'Connect your mailbox — Annie keeps notes and dormancy up to date',
      '150 contact lookups/mo, top-ups available',
    ],
    featured: true,
  },
  {
    key: 'team',
    name: 'Team',
    blurb: 'For an agency, 3 seats minimum.',
    monthly: 99,
    yearly: 84,
    perSeat: true,
    features: [
      'Everything in Solo, per seat',
      'Shared CRM across your team',
      'One combined network — every colleague\'s contacts count as a way in',
      '400 contact lookups/mo, shared',
      'Team admin and insights view',
    ],
  },
]

// Stripe keeps sending the tier key a subscription was created with, and
// stripe-webhook.js is the only writer of the subscriptions table — so a
// webhook can still arrive saying 'growth' or 'starter' long after the
// database has been migrated. This lives here rather than in
// netlify/functions/lib/entitlements.js because BOTH sides need it: the server
// to resolve entitlements, and the browser to render the right plan in
// Billing, Overview and the support widget. Netlify functions already import
// from this file (see admin-daily-metrics-snapshot.js).
//
// Do not delete this on the strength of the database being migrated — the
// database is not where these arrive from.
export const TIER_ALIASES = {
  starter: 'solo',
  growth: 'solo',
}

export function canonicalTier(tier) {
  if (!tier) return null
  return TIER_ALIASES[tier] || tier
}

export function tierByKey(key) {
  const k = canonicalTier(key)
  return TIERS.find(t => t.key === k) || null
}

// $/month this one subscription contributes to MRR. Returns 0 for
// anything not actually paying (unknown tier, unknown interval, or a
// status the caller hasn't classified as live) rather than throwing —
// callers summing across many rows shouldn't have to guard every one.
export function monthlyRevenueFor({ tier, billing_interval, seats }) {
  const t = tierByKey(tier)
  if (!t) return 0
  const perSeat = billing_interval === 'year' ? t.yearly : t.monthly
  if (!Number.isFinite(perSeat)) return 0
  const seatCount = t.perSeat ? Math.max(1, Number(seats) || 1) : 1
  return perSeat * seatCount
}
