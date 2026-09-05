// A day's work, with a bottom to it.
//
// THE PROBLEM THIS EXISTS FOR. The feed held eight backlog leads and refilled
// itself from a pool of ~600 eligible contacts the moment one was worked. On
// the measured 753-contact account that is 600 senior relationships behind a
// list that never got shorter: no end to the day, no sense of progress, and no
// reason to open the product tomorrow rather than whenever. A list that always
// looks full is a treadmill, and a treadmill is not a habit.
//
// So the feed now shows a SET: a fixed number of leads chosen once, worked
// down, and finished. What is not in today's set is deferred to tomorrow —
// never suppressed, always countable, and visible in full in the queue.
//
// HOW THE SET IS KEPT STABLE — the list at 9am is the list at 4pm.
//
//   1. Membership is chosen ONCE per day and recorded (day key + the chosen
//      ids, in order). Every later render reads the record back and looks the
//      ids up; it never re-runs the choice. So nothing that moves during a day
//      can change who is on the list: freshness decay, a colleague importing
//      contacts, the scan writing new signals mid-morning, or — the important
//      one — the recruiter working a lead, which used to hand up a
//      replacement.
//
//   2. The recorded ids are pinned into the build (backlogRanking's `pin`), so
//      a name chosen this morning cannot be squeezed out of the pool by a
//      score that moved underneath it. It leaves the list when the recruiter
//      finishes with it, and no other way.
//
//   3. Order comes from the record too, not from the current score, so cards
//      do not swap places under the reader's cursor mid-read.
//
// The record is a memo, not a source of truth. Lose it (new device, cleared
// storage) and the set is re-chosen from the same ranking — the day may then
// be re-drawn once, which is a far smaller failure than a list that reshuffles
// under someone all day.
//
// WHAT IS DELIBERATELY NOT HERE: any form of top-up. When the set is worked
// through, the feed says so and stops. Refilling it to keep the page looking
// busy is exactly the behaviour this replaces.
//
// COPY RULE, Michael 2026-09-05: no recruiter-marketing language, and nothing
// motivational or gamified — no streaks, no congratulation, no "great job". A
// completion state states a fact and stops. See whyNow.js's header.
import { STATE_NEW, STATE_WORKING, STATE_PARKED } from './buildStream'

// A recruiter works a handful of BD calls a day. Eight is what the backlog cap
// already held, kept deliberately: the change here is that eight is now a
// day's work rather than a window onto six hundred.
export const DAILY_SET_SIZE = 8

// How many leads are built behind the set. Wide enough that the set can always
// be filled after same-company cards merge, narrow enough that the build stays
// off the critical path — 600 full cards costs ~2.5s on a 900-contact CRM.
export const DAILY_POOL_SIZE = DAILY_SET_SIZE * 3

/**
 * The local calendar day, as 'YYYY-MM-DD'.
 *
 * Local rather than UTC on purpose: the day has to turn over when the
 * recruiter's day does. In the Gulf, where this product is used, UTC midnight
 * lands at 4am — inside the working night for nobody, but a UTC day boundary
 * would also mean a 4pm reload in London re-drawing the list of someone in
 * Dubai who is only halfway through it.
 */
export function dayKey(now = new Date()) {
  const pad = n => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function isSameDay(record, key) {
  return Boolean(record && record.key === key && Array.isArray(record.ids))
}

/**
 * Today's set, out of the whole ranked stream.
 *
 * items   the full stream from buildStream (already ranked)
 * key     dayKey() for the day being shown
 * record  { key, ids } as last saved, or null on the first load of the day
 *
 * Returns everything the feed needs to render a finite day:
 *   today      what goes on screen, in order: work in progress first, then
 *              the day's set
 *   working    in-flight items, which are on screen whether or not they are
 *              in the set — a recruiter who told Annie they are on something
 *              must never have to hunt for it
 *   open       set members still to deal with
 *   deferred   ranked leads that exist but are not today's work
 *   done       every member of the set is worked, parked or dismissed
 *   thin       the network could not fill the set today
 */
export function selectDailySet({ items = [], key = dayKey(), record = null, size = DAILY_SET_SIZE } = {}) {
  const byId = new Map(items.map(i => [i.id, i]))
  const working = items.filter(i => i.state === STATE_WORKING)
  const workingIds = new Set(working.map(i => i.id))

  // Chosen once. On every later load of the same day the answer comes from the
  // record, so nothing that has moved since this morning can rewrite it.
  const ids = isSameDay(record, key)
    ? record.ids
    : items.filter(i => i.state === STATE_NEW).slice(0, size).map(i => i.id)

  // One company, one card: a row on today's list can be folded into another
  // card during the day (companyContext.js), which changes the id without
  // changing the lead. Following the merge is what stops that reading as
  // "dealt with" and quietly shrinking the day.
  const hostOf = new Map()
  for (const i of items) for (const absorbed of i.absorbed || []) hostOf.set(absorbed, i)

  // A member that is no longer in the stream at all HAS been dealt with:
  // marked done, dismissed, or contacted, which removes a backlog lead at the
  // source. It counts as resolved rather than as something to replace.
  const present = []
  const seen = new Set()
  for (const id of ids) {
    const found = byId.get(id) || hostOf.get(id) || null
    if (!found || seen.has(found.id)) continue
    seen.add(found.id)
    present.push(found)
  }
  const open = present.filter(i => i.state !== STATE_PARKED)

  const today = [...working, ...open.filter(i => !workingIds.has(i.id))]

  const deferred = items.filter(i => i.state === STATE_NEW && !seen.has(i.id) && !workingIds.has(i.id))

  return {
    key,
    ids,
    size,
    today,
    working,
    open,
    deferred,
    chosen: ids.length,
    resolved: ids.length - open.length,
    // An empty set is not a finished day. Saying "that is today's list" to
    // someone who was never given one would be a lie told by a state machine.
    done: ids.length > 0 && open.length === 0,
    thin: ids.length > 0 && ids.length < size,
    empty: ids.length === 0,
  }
}

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
function count(n) {
  return n >= 0 && n < WORDS.length ? WORDS[n] : String(n)
}
function Count(n) {
  const w = count(n)
  return w.charAt(0).toUpperCase() + w.slice(1)
}

/**
 * What the feed says about the state of the day, in plain sentences.
 *
 * Returns null while there is still work on the list — a day in progress needs
 * no commentary, and a line that says nothing trains the reader to skip every
 * line. Copy lives here rather than in the component so the exact words are
 * under test.
 */
export function dailySetLines({ chosen = 0, size = DAILY_SET_SIZE, done = false, thin = false, empty = false, working = 0, remaining = 0 } = {}) {
  if (empty) {
    return {
      heading: 'Nothing to call today.',
      detail: remaining > 0
        ? 'Everything Annie can put in front of you is already in progress or parked. The rest of your network is in the queue behind it.'
        : 'Nobody in your network is uncontacted, senior enough to commission a search and inside the sectors you chose. New names appear when your contacts change or something moves at a company you know.',
    }
  }

  if (done) {
    const worked = chosen === 1
      ? 'The one lead on it is worked, parked or dismissed.'
      : `All ${chosen} are worked, parked or dismissed.`
    const next = remaining > 0
      ? `${remaining} more in your network. The next set is tomorrow.`
      : 'The queue behind it is empty too. New names appear when your contacts change or something moves at a company you know.'
    const inflight = working > 0
      ? ` ${working === 1 ? 'One is' : `${Count(working)} are`} still marked Working above.`
      : ''
    return { heading: 'That is today\'s list.', detail: `${worked} ${next}${inflight}` }
  }

  if (thin) {
    return {
      heading: `${Count(chosen)} today, not ${count(size)}.`,
      detail: remaining > 0
        ? 'That is what your network has ready to call today. The rest of it is in the queue behind them.'
        : 'That is everyone in your network who is senior enough, works in a sector you chose and has not been contacted yet. Weaker names are not added to make up the number.',
    }
  }

  return null
}

/**
 * The line that keeps the rest of the network visible.
 *
 * Never hide a lead: anything not shown today is deferred, and the count says
 * so out loud on a day that looks short.
 */
export function queueLine(remaining = 0) {
  if (!remaining) return null
  return remaining === 1 ? '1 more in your network.' : `${remaining} more in your network.`
}

/**
 * The whole queue, as rows.
 *
 * Two populations, in this order and not interleaved: leads already built into
 * the stream that today's set did not reach, then the rest of the ranked
 * network. They are not merged because their scores are not the same scale —
 * a stream item is scored on route in, event type and freshness; a backlog
 * entry on seniority, account depth and how recently you connected. Sorting
 * one list by two rulers would put names in an order nothing could explain.
 */
export function queueRows({ deferred = [], backlog = [] } = {}) {
  const rows = []
  for (const item of deferred) {
    const person = item.person || item.wayIn?.person || null
    rows.push({
      key: item.id,
      name: person?.name || item.signal?.company_name || 'Unnamed',
      detail: person
        ? [person.title, item.signal?.company_name].filter(Boolean).join(' · ')
        : item.signal?.headline || '',
      company: item.signal?.company_name || null,
    })
  }
  for (const entry of backlog) {
    const c = entry.contact || {}
    rows.push({
      key: `backlog:${c.id}`,
      name: c.name || 'Unnamed',
      detail: [c.title, c.company].filter(Boolean).join(' · '),
      company: c.company || null,
    })
  }
  return rows
}
