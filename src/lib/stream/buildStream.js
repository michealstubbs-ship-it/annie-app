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
// Everything else is ranked, never suppressed. That holds for the pooled
// employer weight added on 2026-09-05 too: it subtracts a capped amount from a
// score and can never remove a card or take one below a weaker way-in.

import { computeWayIn, RUNG_SPOKEN, RUNG_CANDIDATE, RUNG_CONTACT, RUNG_COLD } from './wayIn.js'
import { buildLinkedinRoute } from './linkedinRoute.js'
import { looksLikeNonEmployerOrg } from '../agencyMatch.js'
import { NEWS_SIGNAL_TYPES } from '../signalTypes.js'

import { buildBacklogSignals, BACKLOG_TYPE_WEIGHT, BACKLOG_SIGNAL_TYPE } from './backlogSignals'
import { isPlaceholderCompany } from '../backlogRanking'
import { employerKey, employerPenalty, describeEmployerSignal } from '../employerSignal'
import { normalizeCompanyName } from '../companyMatch'
import { attachCompanyContext } from './companyContext'
import { buildCompanyPanel } from './companyPanel'
import { provenanceFor } from './provenance'
import { whyPerson } from './whyNow'

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
  // A relationship the recruiter already owns and has never used. No event
  // attached, so it must not out-rank a real trigger — level with live_job,
  // and the way-in rung separates them from there.
  [BACKLOG_SIGNAL_TYPE]: BACKLOG_TYPE_WEIGHT,
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

// parkedEmployers: Map<companyKey, { parkedVoters, workedVoters } | null>, the
// pooled verdict on the employers on screen. Optional, and absent everywhere
// except the live stream — the weight is a refinement of this ranking, not a
// second ranking, and everything scores identically without it.
//
// THE SUBTRACTION IS CAPPED AND FLOORED, and both bounds are the point. Capped
// at MAX_EMPLOYER_PENALTY (10), which is less than the smallest gap between
// two rungs of the way-in ladder (12), so no amount of pooled parking can push
// a lead you have a route into below one you do not. Floored at zero, so the
// weight can only ever reorder — nothing here removes an item from the stream,
// and buildStream keeps every score-zero item exactly as it always did.
//
// Michael, on this: it is a weight, not a ban. A firm that is wrong for one
// recruiter may be right for a contingency recruiter on smaller roles.
export function scoreStreamItem({ signal, wayIn }, { parkedEmployers = null } = {}) {
  const base = (RUNG_WEIGHT[wayIn.rung] || 0)
    + (TYPE_WEIGHT[signal.signal_type] || 1) * 3
    + freshnessScore(signal)

  const key = parkedEmployers ? employerKey(signal.company_name) : null
  const penalty = key ? employerPenalty(parkedEmployers.get(key)) : 0
  return Math.max(0, base - penalty)
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
// The set of companies the customer has a contact at. Built once per stream
// rather than per signal - on a real account this is 618 companies against 38
// signals, so the wrong order here is 23,000 string comparisons instead of 656.
export function buildKnownCompanies(contacts = []) {
  const known = new Set()
  for (const c of contacts) {
    const key = normalizeCompanyName(c?.company || '')
    if (key) known.add(key)
  }
  return known
}

export function isWithinNetwork(signal, knownCompanies) {
  // No CRM yet. A customer who has imported nothing has no network to be
  // outside of, and hiding everything would make the product look broken on
  // day one. Matches the scan's own empty-watchlist behaviour.
  if (!knownCompanies || knownCompanies.size === 0) return true

  const key = normalizeCompanyName(signal?.company_name || '')
  if (key && knownCompanies.has(key)) return true

  // A job move is about a person the customer knows, and the destination is by
  // definition a company they do not - "Mohammad has joined PIF" is a lead
  // precisely because PIF is new. linked_contact_id is only ever set by the
  // import diff and the backlog, both of which start from the customer's own
  // CRM, so it cannot let an open-market stranger through.
  if (signal?.linked_contact_id) return true

  return false
}

// backlogWorking / backlogPin are contact ids: the people the recruiter has
// marked Working on a backlog card, and the people in today's recorded set.
// Both must reach the stream whatever the ranking says today — see
// backlogRanking.js's `pin` and stream/dailySet.js.
//
// parkedEmployers is the pooled, desk-scoped verdict on employers, keyed by
// normalised company name — a weight on the score, never a filter. See
// employerSignal.js.
export function buildStream({ signals = [], contacts = [], candidates = [], functions = [], backlogLimit, parkedEmployers = null, backlogWorking = new Set(), backlogPin = new Set() } = {}) {
  const knownCompanies = buildKnownCompanies(contacts)
  // The measurement that put this here: on a real account, 600 of 753 contacts
  // were C-suite or Director/VP/Head and not one had ever been contacted, while
  // the market scan beside them was surfacing scaffolding firms and law
  // offices. The best leads were already in the CRM. These are merged into the
  // same stream rather than shown in a separate tab, because a recruiter wants
  // one ranked list of who to call, not two lists to reconcile.
  const backlog = buildBacklogSignals({ contacts, signals, functions, limit: backlogLimit, working: backlogWorking, pin: backlogPin })
  const items = []
  for (const signal of [...signals, ...backlog]) {
    if (!signal || signal.status === 'actioned') continue
    // Not a lead: a "live job" at a membership body, a meetup group or an
    // agency is not an employer hiring.
    if (signal.signal_type === 'live_job' && looksLikeNonEmployerOrg(signal.company_name, signal.company_industry)) continue

    // FEED-1, and the first thing Michael said about the rebuilt feed:
    // "Confidential is not a company. So, this should not have showed up."
    // The top card that day was a live role at "Confidential", and the same
    // card was still there after the network-first release, because
    // isPlaceholderCompany was wired into the backlog and the import diff and
    // never into the signals the scan itself writes.
    //
    // A lead has to be a lead at a nameable employer. If Annie cannot say where
    // the role is, she cannot tell the recruiter who to call, and every action
    // on the card - find the contact, draft the approach - is spending effort
    // against a company that was never identified.
    if (isPlaceholderCompany(signal.company_name)) continue

    // THE NETWORK GATE. Measured on a real account the day after the
    // network-first release shipped: 35 of 38 feed items were at companies the
    // recruiter had never heard of, and the three that did match his CRM were
    // artefacts. Genuine network leads: zero.
    //
    // The scan is now scoped to the customer's own companies, which fixes the
    // cause. This is the backstop, and it is here rather than only in the scan
    // because signals outlive the run that created them: rows written before
    // this release, rows from the shared signal pool, and anything a future
    // source adds all arrive through this same function.
    //
    // A signal earns its place two ways - the company is one the customer has a
    // contact at, or the signal names a contact they already know (a job move
    // is about the person, and the new employer is a company they are not
    // supposed to know yet; that is the whole point of the lead).
    //
    // Anything the recruiter has already touched is exempt. If they marked a
    // lead as working, or deliberately parked it, they have made a judgment
    // about it and Annie does not get to overrule that by hiding it - a card
    // vanishing out of "Working" because a filter changed is the product losing
    // someone's work. Caught by the existing ordering test, which had a working
    // item at a company outside the network and expected it to survive.
    const alreadyJudged = signal.status === STATE_WORKING || signal.status === STATE_PARKED
    if (!alreadyJudged && !isWithinNetwork(signal, knownCompanies)) continue

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

  for (const item of items) {
    item.score = scoreStreamItem(item, { parkedEmployers })
    // Carried on the item so the weight is inspectable rather than a silent
    // reshuffle — same reason exclusionReason returns its reason instead of
    // just dropping a contact. Null whenever the weight is doing nothing,
    // which is almost always.
    const key = parkedEmployers ? employerKey(item.signal.company_name) : null
    item.employerSignal = key ? describeEmployerSignal(parkedEmployers.get(key)) : null
  }

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

  // One company, one card. Everything else Annie found at that company now
  // hangs off the row that names somebody to call, rather than sitting three
  // rows further down as its own card. See companyContext.js.
  const merged = attachCompanyContext(items)

  const byId = new Map(contacts.filter(c => c?.id).map(c => [c.id, c]))
  for (const item of merged) {
    // The contact the card is about, if it is about one. The backlog sets
    // linked_contact_id; the way-in ladder finds the person for everything else.
    const person = byId.get(item.signal.linked_contact_id) || item.wayIn?.person || null
    item.person = person
    // Why THIS PERSON — Michael's own critique of the shipped card.
    item.whyPerson = person
      ? whyPerson(person, { company: item.signal.company_name, contacts, functions })
      : null
    // Who else the recruiter knows there, and what that list means.
    item.companyPanel = buildCompanyPanel({ signal: item.signal, wayIn: item.wayIn, contacts, functions })
    // What am I looking at, and where did it come from. On every card, always.
    item.provenance = provenanceFor(item, { contact: person })
  }

  return merged
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
