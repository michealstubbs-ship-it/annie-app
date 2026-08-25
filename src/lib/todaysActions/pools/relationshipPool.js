import { daysSince, decayFall, norm } from '../shared.js'
import { BD_ACTION_SIGNAL_TYPES } from '../eligibility.js'

const RELATIONSHIP_FRESH_DAYS = 14

export function isEligibleRelationship(s, linkedContact) {
  if (!linkedContact) return false // not an existing contact, belongs in sourcedPool instead
  if (s.status === 'actioned') return false
  const manuallyAdded = !!s.manually_added_at
  // Today's BD Actions only ever surfaces the whitelisted signal types on
  // an ordinary scan-sourced signal. 2026-08-25 change, per Michael (see
  // the identical fix in sourcedPool.js's isEligibleSourced for the full
  // reasoning): a manual "Add to Today's BD Actions" click from the Feed
  // bypasses the type whitelist too, for a company Annie already knows
  // just as much as for a brand-new one — the customer explicitly chose
  // this signal either way.
  if (!manuallyAdded && !BD_ACTION_SIGNAL_TYPES.includes(s.signal_type)) return false
  // A signal the user explicitly pulled in via "Add to Today's BD Actions"
  // on the Feed always clears the freshness window — they already decided
  // it's worth pursuing, so it's not this pool's place to second-guess
  // that. Still scored/ranked normally, just never dropped for being old.
  if (manuallyAdded) return true
  const daysFound = daysSince(s.found_at) ?? 999
  // A leadership-change signal about a company Annie already knows is
  // worth a longer freshness window than the ordinary 14 days — see
  // sourcedPool.js's comment on the same signal type for why.
  const isLeadershipChange = s.signal_type === 'leadership_change'
  return daysFound <= (isLeadershipChange ? 60 : RELATIONSHIP_FRESH_DAYS)
}

export function scoreRelationship(s) {
  const daysFound = daysSince(s.found_at) ?? 999
  const isLeadershipChange = s.signal_type === 'leadership_change'
  const score = Math.min(100, decayFall(daysFound, 5, 60) + 25 + (isLeadershipChange ? 15 : 0))
  const urgency = isLeadershipChange && daysFound <= 60 ? 2 : daysFound <= 3 ? 1 : 0 // still public, someone else could see it too
  return { score, urgency, daysFound }
}

// Fresh, unactioned signals about a company already in the CRM. Reads from
// the same shared intelligence_signals table the Intelligence Feed and the
// scheduled scan write to, filtered to companies Annie already knows.
// Brand-new companies go to sourcedPool.js instead.
export function buildRelationshipPool(intelligenceSignals, contacts) {
  const contactsByCompany = new Map()
  for (const c of contacts) {
    const key = norm(c.company)
    if (key) contactsByCompany.set(key, c)
  }

  return (intelligenceSignals || [])
    .map(s => ({ s, linkedContact: contactsByCompany.get(norm(s.company_name)) }))
    .filter(({ s, linkedContact }) => isEligibleRelationship(s, linkedContact))
    .map(({ s, linkedContact }) => {
      const { score, urgency, daysFound } = scoreRelationship(s)
      return {
        category: 'relationship',
        score,
        urgency,
        signal: s,
        contact: linkedContact,
        signals: {
          'Signal': s.headline,
          'Company': s.company_name,
          'Detected': `${daysFound} day${daysFound === 1 ? '' : 's'} ago`,
        },
      }
    })
}
