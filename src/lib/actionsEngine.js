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

// Today's BD Actions only ever surfaces these four signal types — everything
// else (M&A, generic hiring-activity mentions, team-building posts, public
// commentary, unclaimed job postings, regulatory) is market intel or noise,
// not a BD trigger, and lives in the Intelligence Feed's News tab or main
// list instead. "Hiring" specifically means live_job (a real, verified,
// specific open role), never hiring_activity (a narrative "company X is
// hiring" mention with no real posting behind it) — see scanShared.js for
// how those two are kept structurally separate at write time. This is a
// single allow-list rather than a growing set of deny-list exclusions
// (regulatory used to be excluded on its own) so adding or removing a type
// from Today's Actions is a one-line change here, not a hunt across both
// pool builders for every place a type needs to be denied.
export const BD_ACTION_SIGNAL_TYPES = ['funding', 'expansion', 'leadership_change', 'live_job']

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
    // Today's BD Actions only ever surfaces the whitelisted signal types
    // (see BD_ACTION_SIGNAL_TYPES above) — never a BD trigger otherwise, so
    // this pool never surfaces anything outside it, even one someone
    // manually added from the Feed (see the same exclusion, and why, on
    // buildSourcedPool below).
    .filter(s => BD_ACTION_SIGNAL_TYPES.includes(s.signal_type))
    .map(s => {
      const linkedContact = contactsByCompany.get(norm(s.company_name))
      if (!linkedContact) return null // not an existing contact, belongs in sourced

      const daysFound = daysSince(s.found_at) ?? 999
      // A leadership-change signal about a company Annie already knows is
      // worth a longer freshness window than the ordinary 14 days — see
      // buildSourcedPool's comment on the same signal type for why.
      const isLeadershipChange = s.signal_type === 'leadership_change'
      // A signal the user explicitly pulled in via "Add to Today's BD
      // Actions" on the Feed always clears this window — they already
      // decided it's worth pursuing, so it's not this pool's place to
      // second-guess that on freshness grounds. Still scored/ranked
      // normally below, just never dropped for being old.
      if (!s.manually_added_at && daysFound > (isLeadershipChange ? 60 : SIGNAL_FRESH_DAYS)) return null

      const score = Math.min(100, decayFall(daysFound, 5, 60) + 25 + (isLeadershipChange ? 15 : 0))

      return {
        category: 'relationship',
        score,
        urgency: isLeadershipChange && daysFound <= 60 ? 2 : daysFound <= 3 ? 1 : 0, // still public, someone else could see it too
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
    // Today's BD Actions only ever surfaces the whitelisted signal types
    // (see BD_ACTION_SIGNAL_TYPES above) — M&A, regulatory, public
    // commentary, generic hiring-activity mentions, team-building posts and
    // unclaimed job postings never belong here, on principle, not just by
    // default scoring. Applied before the manually-added bypass even gets a
    // chance to run, so choosing "Add to Today's BD Actions" on one from the
    // Feed can't override this either.
    .filter(s => BD_ACTION_SIGNAL_TYPES.includes(s.signal_type))
    // 2026-08-23: a real BD action always comes with someone to actually
    // approach — a card whose "who to approach" is just a generic role
    // ("CFO or Head of Corporate Development") with nobody's name behind it
    // isn't a lead yet, it's a headline. This used to only be enforced by
    // hiding the message/pitch panel inside the card, which meant the card
    // itself — headline, "what Annie found", a candidate pitch worded as a
    // ready line — still showed up as if it were a task for today. No
    // bypass for a manually-added signal either, same as the type whitelist
    // above: adding a signal to the list doesn't conjure a contact for it.
    .filter(s => s.contact_verified || (Array.isArray(s.contact_candidates) && s.contact_candidates.length > 0))
    .map(s => {
      const daysFound = daysSince(s.found_at) ?? 999
      // Leadership-change gets a wider cutoff than the ordinary
      // SOURCED_MAX_AGE_DAYS (21 days) — see the urgency comment below for
      // why a new leader stays a live opportunity for months, not weeks.
      const maxAgeDays = s.signal_type === 'leadership_change' ? 60 : SOURCED_MAX_AGE_DAYS
      // Same manually-added bypass as buildRelationshipPool above: a signal
      // the user explicitly chose from the Feed always clears this age
      // cutoff, still scored/ranked normally, just never dropped for age.
      if (!s.manually_added_at && daysFound > maxAgeDays) return null // see SOURCED_MAX_AGE_DAYS — this is the actual fix for M2

      // live_job: a real, specific open role Annie found and verified, not a
      // narrative "this company is hiring" mention — the most actionable lead
      // this pool can surface, so it gets both a score bump and a wider
      // "still counts as urgent" window than an ordinary racy signal type (an
      // actual open req stays live longer than a news mention does).
      const isLiveJob = s.signal_type === 'live_job'
      // A newly appointed leader is one of the highest-value signals this
      // pool surfaces — someone new in a role is, almost by definition,
      // about to evaluate their team and often bring in their own people —
      // but it was scoring and ranking like an ordinary low-urgency signal
      // (racy: false in signalTypes.js, correctly, since it isn't a
      // fast-closing news event the way a funding round is), so it was
      // getting buried at the bottom of an otherwise uncurated list next to
      // dozens of lower-value items. Bumped here on its own terms rather
      // than folded into RACY_SIGNAL_TYPES, since "time-sensitive because
      // someone might scoop the news" and "time-sensitive because a new
      // decision-maker is actively deciding who's on their team" are
      // different reasons that happen to both deserve urgency=2.
      const isLeadershipChange = s.signal_type === 'leadership_change'
      const score = Math.min(100, decayFall(daysFound, 3, 55) + 25 + (s.contact_verified ? 15 : 0) + (isLiveJob ? 10 : 0) + (isLeadershipChange ? 15 : 0))
      const isRacy = RACY_SIGNAL_TYPES.includes(s.signal_type)
      // A new leader typically spends their first couple of months, not
      // just days, assessing and rebuilding their team, so this window is
      // deliberately wider than the 3-7 day windows above.
      const urgency = isLiveJob && daysFound <= 7 ? 2
        : isRacy && daysFound <= 3 ? 2
        : isLeadershipChange && daysFound <= 60 ? 2
        : daysFound <= 7 ? 1 : 0

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

// Stable identity for a Today's Actions item across a merge — the id of the
// real record it's actually about, never its position or its content, so
// re-scoring the pools doesn't read as "a new item" just because a score
// shifted slightly. keyContext is an optional extra discriminator (e.g. a
// contact's last_contacted timestamp) for the three CRM categories that have
// no natural "done" flag on their underlying record — see mergeActions and
// TodaysActions.jsx's markDone for why: it lets a contact that goes dormant,
// gets re-engaged, and later drifts dormant again be treated as a genuinely
// new occurrence rather than permanently suppressed by an old "mark done".
export function actionKey(action) {
  if (!action) return null
  if (action.signalId) return `signal:${action.signalId}`
  if (action.dealId) return `meeting:deal:${action.dealId}:${action.keyContext || ''}`
  if (action.contactId) return `${action.category}:contact:${action.contactId}:${action.keyContext || ''}`
  return null
}

// Merges freshly-selected pool items into whatever Today's Actions already
// has cached, instead of wholesale-replacing the whole list on every load —
// see the plan note "Today's actions should always be there, not that you
// have to generate it all the time." A cached item stays exactly as it is
// (no re-running AI enrichment on something already shown, no reshuffled
// copy) unless: its key is in dismissedKeys (explicitly marked done, for the
// CRM categories that have no server-side status to check instead), or its
// underlying record is no longer active — activeIds reflects contacts/deals
// currently on file and signals not already filtered to exclude 'actioned'
// ones, so a signal marked actioned anywhere (this page's own "mark done",
// or the Feed's "Mark seen") naturally drops out here too, no separate
// bookkeeping needed for that half. A genuinely new item the pools now
// produce that isn't already represented gets appended. The merged list is
// re-sorted with the same urgency-then-score rule selectDailyItems uses, so
// ranking stays correct even though kept items' own content never changes.
export function mergeActions(cachedActions, freshActions, activeIds, dismissedKeys) {
  const dismissed = dismissedKeys instanceof Set ? dismissedKeys : new Set(dismissedKeys || [])
  const { signalIds = new Set(), contactIds = new Set(), dealIds = new Set() } = activeIds || {}

  function stillActive(action) {
    const key = actionKey(action)
    if (key && dismissed.has(key)) return false
    if (action.signalId) return signalIds.has(action.signalId)
    if (action.dealId) return dealIds.has(action.dealId)
    if (action.contactId) return contactIds.has(action.contactId)
    return false // no stable identity to verify against, don't keep an item around unverified
  }

  const kept = (cachedActions || []).filter(stillActive)
  const keptKeys = new Set(kept.map(actionKey).filter(Boolean))
  const added = (freshActions || []).filter(a => {
    const key = actionKey(a)
    if (!key || keptKeys.has(key)) return false
    if (dismissed.has(key)) return false
    return true
  })

  return [...kept, ...added].sort((a, b) => (b.urgency - a.urgency) || ((b.score || 0) - (a.score || 0)))
}
