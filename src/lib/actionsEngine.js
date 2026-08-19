// Deterministic candidate selection for Today's Actions.
// Selection is decided entirely here, in code, using real computed signals.
// AI is only ever used afterwards to write copy for items already chosen.

const DAY_MS = 24 * 60 * 60 * 1000
const DORMANT_THRESHOLD_DAYS = 60
const SIGNAL_FRESH_DAYS = 14
const MIN_SCORE = 20 // quality bar, items below this never make the list
const MAX_ITEMS = 12 // sane display ceiling, not a target to fill

function daysSince(dateStr) {
  if (!dateStr) return null
  const diff = Date.now() - new Date(dateStr).getTime()
  return Math.floor(diff / DAY_MS)
}

function statusWeight(status) {
  return { hot: 30, warm: 18, cold: 8, client: 0, inactive: 0 }[status] ?? 10
}

export function buildDormantPool(contacts) {
  return contacts
    .filter(c => !['client', 'inactive'].includes(c.status))
    .map(c => {
      const days = daysSince(c.last_contacted) ?? daysSince(c.created_at) ?? 999
      if (days < DORMANT_THRESHOLD_DAYS) return null
      const score = Math.min(100, (days - DORMANT_THRESHOLD_DAYS) * 0.4 + statusWeight(c.status))
      return {
        category: 'dormant',
        score,
        contact: c,
        signals: {
          'Last contacted': c.last_contacted ? `${days} days ago` : 'Never logged, added ' + days + ' days ago',
          'Company': c.company || 'Not set',
          'Status': c.status,
        },
      }
    })
    .filter(Boolean)
}

export function buildMeetingPool(deals, contacts) {
  const contactById = new Map(contacts.map(c => [c.id, c]))
  return deals
    .filter(d => d.stage === 'approached')
    .map(d => {
      const linkedContact = d.contact_id ? contactById.get(d.contact_id) : null
      const lastTouch = linkedContact?.last_contacted || d.updated_at
      const days = daysSince(lastTouch) ?? 0
      if (days < 2) return null // too soon to chase
      const score = Math.min(100, days * 3 + (d.value > 0 ? 15 : 0))
      return {
        category: 'meeting',
        score,
        deal: d,
        contact: linkedContact,
        signals: {
          'First outreach sent': `${days} days ago`,
          'Reply so far': 'None logged',
          'Pipeline stage': 'Approached',
        },
      }
    })
    .filter(Boolean)
}

// Fresh, unactioned signals against any contact already in the CRM.
// No longer gated on a target company list, sectors and markets already
// shape which contacts and signals exist in the first place.
export function buildRelationshipPool(signals, contacts) {
  const contactById = new Map(contacts.map(c => [c.id, c]))
  return signals
    .filter(s => !s.is_actioned)
    .map(s => {
      const days = daysSince(s.created_at) ?? 999
      if (days > SIGNAL_FRESH_DAYS) return null
      const linkedContact = s.contact_id ? contactById.get(s.contact_id) : null
      const score = Math.min(100, (SIGNAL_FRESH_DAYS - days) * 4 + 25)
      return {
        category: 'relationship',
        score,
        signal: s,
        contact: linkedContact,
        signals: {
          'Signal': s.title,
          'Company': s.company,
          'Detected': `${days} days ago`,
        },
      }
    })
    .filter(Boolean)
}

// Promising contacts, hot or warm, who don't have an active deal open yet.
// No longer gated on a target company list, status already reflects how
// promising a contact is, set manually or via the LinkedIn import scoring.
export function buildNewClientPool(contacts, deals) {
  const activeDealCompanies = new Set(
    deals.filter(d => !['won', 'lost'].includes(d.stage)).map(d => (d.company || '').toLowerCase())
  )
  return contacts
    .filter(c => ['hot', 'warm'].includes(c.status))
    .map(c => {
      if (activeDealCompanies.has((c.company || '').toLowerCase())) return null
      const score = Math.min(100, statusWeight(c.status) * 1.6)
      return {
        category: 'new_client',
        score,
        contact: c,
        signals: {
          'Status': c.status,
          'Company': c.company || 'Not set',
          'Active deal': 'None yet',
        },
      }
    })
    .filter(Boolean)
}

// Guarantees at least one slot per populated category, then fills remaining
// slots by score across the combined pool. No fixed total, sized by real volume.
export function selectDailyItems(pools) {
  const categories = Object.keys(pools).filter(k => pools[k].length > 0)
  const selected = []
  const usedIds = new Set()

  function itemId(item) {
    return `${item.category}-${item.contact?.id || item.deal?.id || item.signal?.id}`
  }

  // Guaranteed slot per populated category (highest scoring item first)
  for (const cat of categories) {
    const sorted = [...pools[cat]].sort((a, b) => b.score - a.score)
    const top = sorted.find(i => i.score >= MIN_SCORE)
    if (top) {
      selected.push(top)
      usedIds.add(itemId(top))
    }
  }

  // Fill remaining slots by score across everything, up to the display ceiling
  const remaining = Object.values(pools)
    .flat()
    .filter(i => i.score >= MIN_SCORE && !usedIds.has(itemId(i)))
    .sort((a, b) => b.score - a.score)

  for (const item of remaining) {
    if (selected.length >= MAX_ITEMS) break
    selected.push(item)
    usedIds.add(itemId(item))
  }

  return selected.sort((a, b) => b.score - a.score)
}
