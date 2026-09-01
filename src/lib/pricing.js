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
    features: ['Full CRM, pipeline & contacts', 'Recurring BD signal scan', "Today's Actions", 'Ask Annie (up to 500 messages/mo)', 'LinkedIn import'],
  },
  {
    key: 'growth',
    name: 'Growth',
    blurb: 'For a biller who wants more from Annie.',
    monthly: 129,
    yearly: 109,
    // 2026-08-26 pricing/copy alignment: dropped 'LinkedIn re-import on
    // demand' and 'Priority support' — both were sold here as Growth-
    // exclusive but neither is real. Re-import has no tier check anywhere
    // in the code and SupportWidget.jsx's own fact base already tells
    // customers directly it works "for anyone, regardless of plan" — this
    // bullet contradicted the app's own support answer. Priority support
    // has no differentiated mechanism to sell: support-escalate.js's own
    // header is explicit that every escalation, from every tier, goes to
    // the same one inbox ("he's the entire support team today," Michael's
    // own call, 2026-08-26). Reworded the research bullet from "onboarding
    // research pass" to "research scans" — SCAN_TIER_CONFIG's own comment
    // confirms Growth's deeper scan budget applies to the ongoing cron
    // permanently, not just a one-time signup bonus, which the old wording
    // undersold.
    features: ['Everything in Starter', 'Unlimited Ask Annie messages', 'Deeper, ongoing research scans'],
    featured: true,
  },
  {
    key: 'team',
    name: 'Team',
    blurb: 'For an agency, 3 seats minimum.',
    monthly: 99,
    yearly: 84,
    perSeat: true,
    // 2026-08-26 pricing/copy alignment: 'Shared target-company list'
    // replaced with 'Shared CRM across your team' — there's no
    // target-company-list concept anywhere in the product any more (see
    // LinkedInImport.jsx's own comment, and SupportWidget.jsx's system
    // prompt, rewritten after a real incident specifically to stop
    // claiming this exists). The real, built, RLS-verified Team perk this
    // was presumably meant to gesture at — every teammate seeing the same
    // contacts/companies/deals/jobs/candidates — already exists and is
    // genuinely Team-exclusive (a solo Starter/Growth account has no
    // teammates to share with), so it replaces the fabricated bullet
    // rather than just deleting it.
    features: ['Everything in Growth, per seat', 'Shared CRM across your team', 'Team admin & insights view', 'Volume pricing on extra seats'],
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
