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
export const TIERS = [
  {
    key: 'starter',
    name: 'Starter',
    blurb: 'For a solo recruiter or a single desk.',
    monthly: 79,
    yearly: 69,
    features: ['Full CRM, pipeline & contacts', 'Recurring BD signal scan', "Today's Actions", 'Ask Annie (up to 100 messages/mo)', 'LinkedIn import'],
  },
  {
    key: 'growth',
    name: 'Growth',
    blurb: 'For a biller who wants more from Annie.',
    monthly: 129,
    yearly: 109,
    features: ['Everything in Starter', 'Unlimited Ask Annie messages', 'Deeper onboarding research pass', 'LinkedIn re-import on demand', 'Priority support'],
    featured: true,
  },
  {
    key: 'team',
    name: 'Team',
    blurb: 'For an agency, 3 seats minimum.',
    monthly: 99,
    yearly: 84,
    perSeat: true,
    features: ['Everything in Growth, per seat', 'Shared target-company list', 'Team admin & insights view', 'Volume pricing on extra seats'],
  },
]

export function tierByKey(key) {
  return TIERS.find(t => t.key === key) || null
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
