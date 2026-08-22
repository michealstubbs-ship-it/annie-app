// Deterministic candidate selection for Today's Actions.
// Selection is decided entirely here, in code, using real computed signals.
// AI is only ever used afterwards to write copy for items already chosen.
//
// Two dimensions drive the final list: VALUE (how good is this opportunity, on a
// comparable 0-100 scale across every category) and URGENCY (is someone else likely
// racing you for this right now). There is no fixed slot count per category and no
// ceiling on the total list, whatever clears the quality bar gets shown, however many
// that is on a given day. Urgency is sorted first, value second, because a moderately
// good but fast-closing opportunity should always outrank a high-value one that isn't
// going anywhere today.
import { RACY_SIGNAL_TYPES } from './signalTypes.js'

const DAY_MS = 24 * 60 * 60 * 1000
const DORMANT_THRESHOLD_DAYS = 60
const SIGNAL_FRESH_DAYS = 14
const MIN_SCORE = 20 // quality bar, items below this never make the list, no exceptions

// The pre-launch audit's M2 finding: buildSourcedPool's score decayed
// toward an additive floor (25, or 40 contact-verified) rather than toward
// zero, so an unactioned signal never naturally dropped below MIN_SCORE no
// matter how old it got — it just sat there competing for a slot forever.
// Wider than SIGNAL_FRESH_DAYS on purpose: a sourced signal has no existing
// relationship prompting faster follow-up the way a relationship-pool
// signal does, so it's given longer before being auto-archived, but it does
// still age out.
const SOURCED_MAX_AGE_DAYS = 21

function daysSince(dateStr) {
  if (!dateStr) return null
  const diff = Date.now() - new Date(dateStr).getTime()
  return Math.floor(diff / DAY_MS)
}

function statusWeight(status) {
  return { hot: 30, warm: 18, cold: 8, client: 0, inactive: 0 }[status] ?? 10
}

// Rises from 0 toward `max` as x grows, asymptotically, never overshoots. Used
// wherever staleness should matter but not without bound, a contact idle a year
// shouldn't score meaningfully higher than one idle four months.
function decayRise(x, k, max) {
  if (x <= 0) return 0
  return max * (1 - Math.exp(-x / k))
}

// Falls from near `max` toward 0 as x grows. Used wherever freshness itself is the
// value, a signal found an hour ago matters more than one found a week ago.
function decayFall(x, k, max) {
  return max * Math.exp(-Math.max(0, x) / k)
}

const norm = s => (s || '').trim().toLowerCase()

export function buildDormantPool(contacts) {
  return contacts
    .filter(c => !['client', 'inactive'].includes(c.status))
    .map(c => {
      const days = daysSince(c.last_contacted) ?? daysSince(c.created_at) ?? 999
      if (days < DORMANT_THRESHOLD_DAYS) return null
      const daysOver = days - DORMANT_THRESHOLD_DAYS

      let score = statusWeight(c.status) * 1.3 + decayRise(daysOver, 45, 45)
      // Past a year of silence the relationship is likely cold enough that reopening
      // it is lower-value than a contact who went quiet more recently, not higher.
      if (days > 365) score *= 0.7
      score = Math.min(100, score)

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

      let score = decayRise(days, 12, 65) + (linkedContact ? statusWeight(linkedContact.status) : 10) * 0.6 + (d.value > 0 ? 10 : 0)
      // Past 45 days of silence this is more likely dead than urgent, deprioritise
      // rather than let it keep climbing forever.
      if (days > 45) score *= 0.55
      score = Math.min(100, score)

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
    .filter(Boolean)
}

// Fresh, unactioned signals about a company already in the CRM. Reads from the same
// shared intelligence_signals table the Intelligence Feed and the scheduled scan
// write to, filtered to companies Annie already knows. Brand-new companies go to
// buildSourcedPool instead.
export function buildRelationshipPool(intelligenceSignals, contacts) {
  const contactsByCompany = new Map()
  for (const c of contacts) {
    const key = norm(c.company)
    if (key) contactsByCompany.set(key, c)
  }

  return (intelligenceSignals || [])
    .filter(s => s.status !== 'actioned')
    .map(s => {
      const linkedContact = contactsByCompany.get(norm(s.company_name))
      if (!linkedContact) return null // not an existing contact, belongs in sourced

      const daysFound = daysSince(s.found_at) ?? 999
      if (daysFound > SIGNAL_FRESH_DAYS) return null

      const score = Math.min(100, decayFall(daysFound, 5, 60) + 25)

      return {
        category: 'relationship',
        score,
        urgency: daysFound <= 3 ? 1 : 0, // still public, someone else could see it too
        signal: s,
        contact: linkedContact,
        signals: {
          'Signal': s.headline,
          'Company': s.company_name,
          'Detected': `${daysFound} day${daysFound === 1 ? '' : 's'} ago`,
        },
      }
    })
    .filter(Boolean)
}

// Promising contacts, hot or warm, with no active deal open yet. Freshness now
// genuinely matters, a contact that just went hot is a live opportunity, one that's
// been sitting hot for months with no movement isn't more urgent for having waited.
export function buildNewClientPool(contacts, deals) {
  const activeDealCompanies = new Set(
    deals.filter(d => !['won', 'lost'].includes(d.stage)).map(d => norm(d.company))
  )
  return contacts
    .filter(c => ['hot', 'warm'].includes(c.status))
    .map(c => {
      if (activeDealCompanies.has(norm(c.company))) return null

      const days = daysSince(c.last_contacted) ?? daysSince(c.created_at) ?? 999
      const score = Math.min(100, statusWeight(c.status) * 1.5 + decayFall(days, 20, 25))

      return {
        category: 'new_client',
        score,
        urgency: days <= 5 ? 1 : 0, // freshly hot, worth moving on before it cools or a competitor gets there
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

// Brand-new companies, not yet in the CRM, found by the scheduled background scan.
// This used to be its own live AI + web search call inside Today's Actions, it now
// just reads what the scan already found, no duplicate research, no duplicate cost.
export function buildSourcedPool(intelligenceSignals, contacts) {
  const knownCompanies = new Set(contacts.map(c => norm(c.company)).filter(Boolean))

  return (intelligenceSignals || [])
    .filter(s => s.status !== 'actioned')
    .filter(s => !knownCompanies.has(norm(s.company_name)))
    .map(s => {
      const daysFound = daysSince(s.found_at) ?? 999
      if (daysFound > SOURCED_MAX_AGE_DAYS) return null // see SOURCED_MAX_AGE_DAYS — this is the actual fix for M2

      // live_job: a real, specific open role Annie found and verified, not a
      // narrative "this company is hiring" mention — the most actionable lead
      // this pool can surface, so it gets both a score bump and a wider
      // "still counts as urgent" window than an ordinary racy signal type (an
      // actual open req stays live longer than a news mention does).
      const isLiveJob = s.signal_type === 'live_job'
      const score = Math.min(100, decayFall(daysFound, 3, 55) + 25 + (s.contact_verified ? 15 : 0) + (isLiveJob ? 10 : 0))
      const isRacy = RACY_SIGNAL_TYPES.includes(s.signal_type)
      const urgency = isLiveJob && daysFound <= 7 ? 2 : isRacy && daysFound <= 3 ? 2 : daysFound <= 7 ? 1 : 0

      return {
        category: 'sourced',
        score,
        urgency,
        signal: s,
        signals: {},
      }
    })
    .filter(Boolean)
}

// No fixed slot count per category, no ceiling on the total. Everything that clears
// the quality bar gets shown. Sorted by urgency first (is someone else racing you for
// this), then value (how good is it), so a fast-closing moderate opportunity always
// beats a high-value one that can comfortably wait.
export function selectDailyItems(pools) {
  return Object.values(pools)
    .flat()
    .filter(item => item.score >= MIN_SCORE)
    .sort((a, b) => (b.urgency - a.urgency) || (b.score - a.score))
}
