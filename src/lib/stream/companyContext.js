// One company, one card.
//
// Michael, 2026-09-05: "Well we still need to merge annies ability to research
// a company with the leads we are giving? I thought thats what we discussed,
// that it makes annie more targeted? As an example, annie should be like this
// is the recent news and roles that Khazna have been posting."
//
// Until now the feed could show three separate rows about NEOM — a person you
// know, a live role, and a funding note — and joining them up was the reader's
// job. That was defensible while the scan searched the open market, because
// the person and the event were usually at different companies. Once the scan
// was scoped to the customer's own 618 companies, they are constantly the same
// company, and three rows about one account is just the same lead typed out
// three times.
//
// So: group by company, pick the row that names a person to call, and hang
// everything else Annie found about that company off it. The card stops being
// "here is a signal" and becomes "here is the account".
//
// What is NOT absorbed, deliberately:
//   - anything the recruiter has marked Working or Parked. They made a
//     judgment about that specific row; folding it into another card would
//     lose their work.
//   - a job move, which is about a person at a company they are LEAVING or
//     JOINING. Both halves are their own lead and neither is context.

import { normalizeCompanyName } from '../companyMatch'
import { BACKLOG_SIGNAL_TYPE } from './backlogSignals'

// Deliberately literals rather than an import from buildStream: buildStream
// calls this module, and importing its consts back would make a cycle whose
// failure mode is a temporal-dead-zone crash at first paint. The values are
// pinned by companyContext.test.js, which imports the real ones and asserts
// against them.
const STATE_WORKING = 'working'
const STATE_PARKED = 'parked'

function isOwnLead(item) {
  const s = item.signal
  // A move produces two rows by design (the vacated seat and the new seat) and
  // both are leads in their own right — see linkedinImportDiff.
  return Boolean(s.linked_contact_id) && s.signal_type !== BACKLOG_SIGNAL_TYPE
}

function isJudged(item) {
  return item.state === STATE_WORKING || item.state === STATE_PARKED
}

// A card can only host context if it names somebody to call. A live role with
// no route in has nothing to hang the rest off.
function hostRank(item) {
  const named = item.signal.signal_type === BACKLOG_SIGNAL_TYPE || Boolean(item.wayIn?.person)
  return named ? 1 : 0
}

/**
 * Fold same-company rows into one card each.
 *
 * Returns a new array. Every surviving item gains `happening`: the other
 * things Annie found at that company, newest first, or an empty array.
 *
 * The host inherits the best score in its group, so merging can never push an
 * account down the list — a funding round at NEOM still lifts the NEOM card
 * even though the card is headed by the person you know there.
 */
export function attachCompanyContext(items = []) {
  const groups = new Map()
  const standalone = []

  for (const item of items) {
    if (isJudged(item) || isOwnLead(item)) { standalone.push(item); continue }
    const key = normalizeCompanyName(item.signal?.company_name || '')
    if (!key) { standalone.push(item); continue }
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }

  const out = [...standalone.map(i => ({ ...i, happening: [], absorbed: [] }))]

  for (const group of groups.values()) {
    if (group.length === 1) { out.push({ ...group[0], happening: [], absorbed: [] }); continue }

    const ordered = [...group].sort((a, b) => {
      const h = hostRank(b) - hostRank(a)
      if (h !== 0) return h
      return b.score - a.score
    })
    const [host, ...rest] = ordered

    // A second person you already know is NOT "what is happening at NEOM" —
    // they are another name in the network panel, which already lists them.
    // Caught by running this over the real account: the ADQ card offered
    // "Mohamed Kaissi at ADQ" as a market event, and then listed him again two
    // blocks below. Backlog rows are dropped here rather than absorbed.
    const events = rest.filter(i => i.signal.signal_type !== BACKLOG_SIGNAL_TYPE)

    out.push({
      ...host,
      score: Math.max(...group.map(i => i.score)),
      // Which rows this card now speaks for. Merging happens at 11am as
      // readily as at 9am — the scan writes a funding signal at a company
      // whose backlog card is already on today's list — and without this the
      // recorded id would simply stop existing, which today's set would read
      // as "dealt with" and quietly shrink the day. See stream/dailySet.js.
      absorbed: rest.map(i => i.id),
      happening: events
        .map(i => ({
          id: i.signal.id,
          type: i.signal.signal_type,
          headline: i.signal.headline,
          detail: i.signal.why_it_matters || null,
          roles: Array.isArray(i.signal.likely_roles) ? i.signal.likely_roles : [],
          foundAt: i.signal.found_at || null,
          eventAt: i.signal.event_at || null,
          source: i.source,
          isNews: i.isNews,
        }))
        .sort((a, b) => new Date(b.eventAt || b.foundAt || 0) - new Date(a.eventAt || a.foundAt || 0)),
    })
  }

  // Re-sort, because a host's score may have risen.
  const stateRank = { [STATE_WORKING]: 0, new: 1, [STATE_PARKED]: 2 }
  out.sort((a, b) => {
    const s = (stateRank[a.state] ?? 1) - (stateRank[b.state] ?? 1)
    if (s !== 0) return s
    if (b.score !== a.score) return b.score - a.score
    return new Date(b.signal.found_at || 0) - new Date(a.signal.found_at || 0)
  })

  return out
}
