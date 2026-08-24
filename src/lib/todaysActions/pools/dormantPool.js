import { daysSince, statusWeight, decayRise } from '../shared.js'

const DORMANT_THRESHOLD_DAYS = 60

// Pure predicate — a contact belongs in this pool if, and only if, this
// returns true. Extracted as its own export (not just an inline filter)
// because "does this qualify" is the exact thing that used to live in two
// disagreeing copies (a pool builder and a separate merge-time re-check).
// There's only one copy now, and this is it.
export function isEligibleDormant(c) {
  if (['client', 'inactive'].includes(c.status)) return false
  const days = daysSince(c.last_contacted) ?? daysSince(c.created_at) ?? 999
  return days >= DORMANT_THRESHOLD_DAYS
}

export function scoreDormant(c) {
  const days = daysSince(c.last_contacted) ?? daysSince(c.created_at) ?? 999
  const daysOver = days - DORMANT_THRESHOLD_DAYS
  let score = statusWeight(c.status) * 1.3 + decayRise(daysOver, 45, 45)
  // Past a year of silence the relationship is likely cold enough that
  // reopening it is lower-value than a contact who went quiet more
  // recently, not higher.
  if (days > 365) score *= 0.7
  return { score: Math.min(100, score), days }
}

export function buildDormantPool(contacts) {
  return contacts
    .filter(isEligibleDormant)
    .map(c => {
      const { score, days } = scoreDormant(c)
      return {
        category: 'dormant',
        score,
        urgency: 0, // relationship decay, not a race against a competitor
        contact: c,
        signals: {
          'Last contacted': c.last_contacted ? `${days} days ago` : 'Never logged, added ' + days + ' days ago',
          'Company': c.company || 'Not set',
          'Status': c.status,
        },
      }
    })
}
