import { RACY_SIGNAL_TYPES } from '../../signalTypes.js'
import { daysSince, decayFall, norm } from '../shared.js'
import { BD_ACTION_SIGNAL_TYPES } from '../eligibility.js'
import { looksLikeStaffingAgency } from '../../agencyMatch.js'

const SOURCED_MAX_AGE_DAYS = 21

// Pure predicate — a signal belongs in this pool if, and only if, this
// returns true. This is the exact function whose absence caused the
// 2026-08 bugs: the old code checked "does this qualify" once inline
// inside the pool builder, and a second time, separately, inside the
// merge-cache's stillActive re-check, and the two could disagree. Now
// there's exactly one function that answers this question, called from
// exactly one place (resolve.js, via the pool this produces) — nothing
// downstream re-derives its own opinion of eligibility ever again.
export function isEligibleSourced(s, knownCompanies) {
  if (s.status === 'actioned') return false
  if (knownCompanies.has(norm(s.company_name))) return false
  // 2026-09-02 audit fix, real report: a live_job lead posted by another
  // recruitment/staffing agency (its own founder isn't a hiring manager,
  // there's no real BD opportunity there) kept surfacing here even after
  // scanShared.js's write-time check shipped, because that check only
  // stops a NEW bad signal from being written — it does nothing for one
  // already sitting in the table from before the fix landed, and this pool
  // has no other mechanism that ever retires a stale row on its own. Same
  // check, applied here too, so no live_job signal can surface regardless
  // of when it was written. Only live_job, not every signal type — an
  // agency itself getting funded or expanding is still real BD news.
  if (s.signal_type === 'live_job' && looksLikeStaffingAgency(s.company_name, s.company_industry)) return false
  const manuallyAdded = !!s.manually_added_at
  // Today's BD Actions only ever surfaces the whitelisted signal types on
  // an ordinary scan-sourced signal. 2026-08-25 change, per Michael: a
  // manual "Add to Today's BD Actions" click from the Feed is a different
  // case — the customer explicitly chose this specific signal, so it
  // bypasses the type whitelist ("them clicking add to todays actions
  // should go through the current blocker"). This is exactly the bug that
  // silently ate Stitch before this fix — a funding signal outside the
  // whitelist, manually added, that never surfaced anywhere and looked to
  // the customer like the click just didn't work.
  if (!manuallyAdded && !BD_ACTION_SIGNAL_TYPES.includes(s.signal_type)) return false
  // A real BD action always comes with someone to actually approach — a
  // card whose "who to approach" is just a generic role with nobody's name
  // behind it isn't a lead yet, it's a headline. No bypass for a manually
  // added signal here either: adding a signal to the list doesn't conjure
  // a contact for it. (Every signal gets a real contact-resolution attempt
  // at scan time regardless of type — see buildEnrichedSignalRow in
  // scanShared.js — so this isn't usually a dead end for a manual add.)
  if (!s.contact_verified && !(Array.isArray(s.contact_candidates) && s.contact_candidates.length > 0)) return false
  // A signal the user explicitly chose from the Feed always clears the age
  // cutoff below, still scored/ranked normally, just never dropped for age.
  if (manuallyAdded) return true
  const daysFound = daysSince(s.found_at) ?? 999
  // Leadership-change gets a wider cutoff than the ordinary
  // SOURCED_MAX_AGE_DAYS (21 days) — see the urgency comment in
  // scoreSourced below for why a new leader stays a live opportunity for
  // months, not weeks.
  const maxAgeDays = s.signal_type === 'leadership_change' ? 60 : SOURCED_MAX_AGE_DAYS
  return daysFound <= maxAgeDays
}

export function scoreSourced(s) {
  const daysFound = daysSince(s.found_at) ?? 999
  // live_job: a real, specific open role Annie found and verified, not a
  // narrative "this company is hiring" mention — the most actionable lead
  // this pool can surface, so it gets both a score bump and a wider "still
  // counts as urgent" window than an ordinary racy signal type.
  const isLiveJob = s.signal_type === 'live_job'
  // A newly appointed leader is one of the highest-value signals this pool
  // surfaces — someone new in a role is, almost by definition, about to
  // evaluate their team and often bring in their own people. Scored here on
  // its own terms with a wider window (60 days, not the ordinary racy
  // window of a few days) — "the news might get scooped" and "a
  // decision-maker is actively deciding who's on their team" are different
  // reasons that happen to both deserve urgency=2, just on different
  // timescales. (2026-08-26: leadership_change is now also flagged racy:
  // true in signalTypes.js, so the Feed's own "time-sensitive" badge
  // matches this page's treatment of the same signal — see that file's
  // comment. That only affects the `isRacy && daysFound <= 3` branch below,
  // which the isLeadershipChange branch already covers for days 0-3 and
  // extends on its own past it; the scoring above and the 60-day window
  // here are unchanged.)
  const isLeadershipChange = s.signal_type === 'leadership_change'
  const score = Math.min(100, decayFall(daysFound, 3, 55) + 25 + (s.contact_verified ? 15 : 0) + (isLiveJob ? 10 : 0) + (isLeadershipChange ? 15 : 0))
  const isRacy = RACY_SIGNAL_TYPES.includes(s.signal_type)
  // A new leader typically spends their first couple of months, not just
  // days, assessing and rebuilding their team, so this window is
  // deliberately wider than the 3-7 day windows below.
  const urgency = isLiveJob && daysFound <= 7 ? 2
    : isRacy && daysFound <= 3 ? 2
    : isLeadershipChange && daysFound <= 60 ? 2
    : daysFound <= 7 ? 1 : 0
  return { score, urgency }
}

// Brand-new companies, not yet in the CRM, found by the background scan.
// This just reads what the scan already found, no duplicate research, no
// duplicate cost.
//
// 2026-09-01 defense-in-depth, same real report as relationshipPool.js's
// buildRelationshipPool comment (Fasset showing 3 times) — this pool has the
// identical missing-collapse gap: nothing here ever grouped multiple
// intelligence_signals rows about the same brand-new company into one card.
// The real fix is not writing the duplicates in the first place (see
// scanShared.js's fundingFuzzyKey), but this pool has no legitimate reason
// to ever show more than one action for the same company regardless of how
// many rows exist about it — collapsed here to the single best
// (highest-scoring) one per company as a second, independent backstop.
export function buildSourcedPool(intelligenceSignals, contacts) {
  const knownCompanies = new Set(contacts.map(c => norm(c.company)).filter(Boolean))

  const eligible = (intelligenceSignals || []).filter(s => isEligibleSourced(s, knownCompanies))

  const bestPerCompany = new Map()
  for (const s of eligible) {
    const key = norm(s.company_name)
    const { score, urgency } = scoreSourced(s)
    const existing = bestPerCompany.get(key)
    if (!existing || score > existing.score) {
      bestPerCompany.set(key, { s, score, urgency })
    }
  }

  return [...bestPerCompany.values()].map(({ s, score, urgency }) => ({
    category: 'sourced',
    score,
    urgency,
    signal: s,
    signals: {},
  }))
}
