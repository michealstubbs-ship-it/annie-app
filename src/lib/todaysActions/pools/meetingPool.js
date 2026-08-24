import { daysSince, statusWeight, decayRise } from '../shared.js'

export function isEligibleMeeting(d, linkedContact) {
  if (d.stage !== 'approached') return false
  const lastTouch = linkedContact?.last_contacted || d.updated_at
  const days = daysSince(lastTouch) ?? 0
  return days >= 2 // too soon to chase
}

export function scoreMeeting(d, linkedContact) {
  const lastTouch = linkedContact?.last_contacted || d.updated_at
  const days = daysSince(lastTouch) ?? 0
  let score = decayRise(days, 12, 65) + (linkedContact ? statusWeight(linkedContact.status) : 10) * 0.6 + (d.value > 0 ? 10 : 0)
  // Past 45 days of silence this is more likely dead than urgent,
  // deprioritise rather than let it keep climbing forever.
  if (days > 45) score *= 0.55
  return { score: Math.min(100, score), days }
}

// Fresh, unactioned signals about a company already in the CRM. Reads from
// the same shared intelligence_signals table the Intelligence Feed and the
// scheduled scan write to, filtered to companies Annie already knows.
// Brand-new companies go to sourcedPool.js instead.
export function buildMeetingPool(deals, contacts) {
  const contactById = new Map(contacts.map(c => [c.id, c]))
  return deals
    .map(d => ({ d, linkedContact: d.contact_id ? contactById.get(d.contact_id) : null }))
    .filter(({ d, linkedContact }) => isEligibleMeeting(d, linkedContact))
    .map(({ d, linkedContact }) => {
      const { score, days } = scoreMeeting(d, linkedContact)
      return {
        category: 'meeting',
        score,
        urgency: 0, // your own responsiveness, not an external race
        deal: d,
        contact: linkedContact,
        signals: {
          'First outreach sent': `${days} days ago`,
          'Reply so far': 'None logged',
          'Pipeline stage': 'Approached',
        },
      }
    })
}
