// The single stream. One list, replacing Today's Actions and the old
// Intelligence Feed, which read the same table and were divided only by an
// invisible contact gate.
//
// Michael, 2026-09-04, approving the rebuild pre-launch: one stream, CRM admin
// moved out of it, and nothing hidden for lacking a contact. Today's Actions
// on day one of the snag week showed nine cards and every one was CRM
// housekeeping — no market signal at all — which is exactly why it read as a
// to-do list rather than intelligence.
//
// What this module does NOT do, deliberately: no eligibility filter that can
// hide a lead. The only things dropped are rows that are not leads at all
// (already actioned, or a "live job" at a body that does not employ anyone).
// Everything else is ranked, never suppressed.

import { computeWayIn, RUNG_SPOKEN, RUNG_CANDIDATE, RUNG_CONTACT, RUNG_COLD } from './wayIn.js'
import { buildLinkedinRoute } from './linkedinRoute.js'
import { looksLikeNonEmployerOrg } from '../agencyMatch.js'
import { NEWS_SIGNAL_TYPES } from '../signalTypes.js'

export const STATE_NEW = 'new'
export const STATE_WORKING = 'working'
export const STATE_PARKED = 'parked'

// intelligence_signals.status carries both "has the customer looked at this"
// (new/seen) and now "what are they doing about it" (working/parked). Only
// 'actioned' removes a row from every read in the app, and that is unchanged.
export function itemStateFromStatus(status) {
  if (status === STATE_WORKING) return STATE_WORKING
  if (status === STATE_PARKED) return STATE_PARKED
  return STATE_NEW
}

// How much a signal type is worth to a recruiter, independent of the route in.
// A funding round or a named leadership change is a reason to call today; a
// regulatory note is background.
const TYPE_WEIGHT = {
  leadership_change: 5,
  funding: 5,
  live_job: 4,
  expansion: 4,
  m_and_a: 3,
  hiring_activity: 2,
  team_building: 2,
  regulatory: 1,
  public_commentary: 1,
}

const RUNG_WEIGHT = {
  [RUNG_SPOKEN]: 40,
  [RUNG_CANDIDATE]: 25,
  [RUNG_CONTACT]: 12,
  [RUNG_COLD]: 0,
}

function daysSince(iso) {
  if (!iso) return null
  const ms = Date.now() - new Date(iso).getTime()
  return Number.isFinite(ms) ? ms / 86400000 : null
}

// Freshness decays rather than cliff-edges, so a strong three-week-old lead
// still outranks a weak one from this morning instead of vanishing at an
// arbitrary cutoff — which is what SOURCED_MAX_AGE_DAYS (21) used to do.
function freshnessScore(signal) {
  const d = daysSince(signal.event_at || signal.found_at)
  if (d === null) return 5
  if (d <= 2) return 20
  if (d <= 7) return 14
  if (d <= 21) return 8
  if (d <= 60) return 3
  return 0
}

export function scoreStreamItem({ signal, wayIn }) {
  return (RUNG_WEIGHT[wayIn.rung] || 0)
    + (TYPE_WEIGHT[signal.signal_type] || 1) * 3
    + freshnessScore(signal)
}

/**
 * Turns raw signal rows into the stream the customer sees.
 *
 * signals    intelligence_signals rows (already de-duplicated by the caller)
 * contacts   the team's contacts
 * candidates the team's candidates
 *
 * Every returned item carries its own way in, its source, and its state, so
 * the component renders without going back to the data layer.
 */
export function buildStream({ signals = [], contacts = [], candidates = [] } = {}) {
  const items = []
  for (const signal of signals) {
    if (!signal || signal.status === 'actioned') continue
    // Not a lead: a "live job" at a membership body, a meetup group or an
    // agency is not an employer hiring.
    if (signal.signal_type === 'live_job' && looksLikeNonEmployerOrg(signal.company_name, signal.company_industry)) continue

    const wayIn = computeWayIn(signal, { contacts, candidates })
    const linkedinRoute = buildLinkedinRoute(signal, wayIn.kind === 'spoken' || wayIn.kind === 'contact' ? wayIn.person : null)

    items.push({
      id: signal.id,
      signal,
      wayIn,
      linkedinRoute,
      state: itemStateFromStatus(signal.status),
      isNews: NEWS_SIGNAL_TYPES.includes(signal.signal_type),
      // The source is shown on every item, always. All 530 signals from the
      // last seven days already carry source_url and source_label — the data
      // was never the problem, only that nothing displayed it.
      source: {
        url: signal.source_url || null,
        label: signal.source_label || null,
        // source_verified false means "not checked", NOT "fake" — two of the
        // unchecked ones were opened by hand on 2026-09-04 and were real
        // pages. The UI says "not yet checked", never anything stronger.
        checked: signal.source_verified === true,
      },
      score: 0,
    })
  }

  for (const item of items) item.score = scoreStreamItem(item)

  // Work in progress sits at the top regardless of score — a recruiter who
  // told Annie they are on something should not have to hunt for it. Parked
  // items sink but are never removed.
  const stateRank = { [STATE_WORKING]: 0, [STATE_NEW]: 1, [STATE_PARKED]: 2 }
  items.sort((a, b) => {
    const s = stateRank[a.state] - stateRank[b.state]
    if (s !== 0) return s
    if (b.score !== a.score) return b.score - a.score
    return new Date(b.signal.found_at || 0) - new Date(a.signal.found_at || 0)
  })

  return items
}

// Counts for the filter bar. Deliberately computed over the whole stream, not
// the filtered view, so switching a filter never changes the numbers next to
// the other filters.
export function streamCounts(items) {
  const counts = { all: items.length, new: 0, working: 0, parked: 0, withWayIn: 0, cold: 0 }
  for (const item of items) {
    counts[item.state] = (counts[item.state] || 0) + 1
    if (item.wayIn.rung === RUNG_COLD) counts.cold += 1
    else counts.withWayIn += 1
  }
  return counts
}
