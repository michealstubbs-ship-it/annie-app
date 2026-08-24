import { daysSince, statusWeight, decayFall, norm } from '../shared.js'

export function isEligibleNewClient(c, activeDealCompanies) {
  if (!['hot', 'warm'].includes(c.status)) return false
  return !activeDealCompanies.has(norm(c.company))
}

export function scoreNewClient(c) {
  const days = daysSince(c.last_contacted) ?? daysSince(c.created_at) ?? 999
  return {
    score: Math.min(100, statusWeight(c.status) * 1.5 + decayFall(days, 20, 25)),
    urgency: days <= 5 ? 1 : 0, // freshly hot, worth moving on before it cools or a competitor gets there
  }
}

// Promising contacts, hot or warm, with no active deal open yet.
export function buildNewClientPool(contacts, deals) {
  const activeDealCompanies = new Set(
    deals.filter(d => !['won', 'lost'].includes(d.stage)).map(d => norm(d.company))
  )
  return contacts
    .filter(c => isEligibleNewClient(c, activeDealCompanies))
    .map(c => {
      const { score, urgency } = scoreNewClient(c)
      return {
        category: 'new_client',
        score,
        urgency,
        contact: c,
        signals: {
          'Status': c.status,
          'Company': c.company || 'Not set',
          'Active deal': 'None yet',
        },
      }
    })
}
