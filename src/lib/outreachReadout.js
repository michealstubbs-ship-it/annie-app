// What happened to the approaches you sent — said back in plain sentences.
//
// A BD tool that cannot tell you which approaches got replies is a list, not
// intelligence. This is the readout that makes it the second thing, and it is
// deliberately the smallest possible version of that: counts the customer can
// verify by hand, and at most one observation, only when the stored data
// actually proves it.
//
// COPY RULE, Michael 2026-09-05 (the same rule documented at the head of
// stream/whyNow.js): no recruiter-marketing language. He named "bench", "new
// seat", "budget and something to prove" and "the warmest call in recruitment"
// as things nobody says. Plain sentences, or nothing — because a generic line
// is worse than none, it trains people to skip the row.
//
// Two rules specific to this file, both of which cost lines that would have
// been nice to have:
//
//   1. NEVER a motivational metric. "You're on a 38% reply rate!" is a number
//      dressed as encouragement; a percentage over eight sends is noise given
//      a confident shape. Whole counts only, over a period the reader can
//      check against their own sent items.
//
//   2. NEVER an observation the data does not carry. Every claim below is
//      guarded on the specific fields being present for EVERY row it talks
//      about — a null seniority band is not "not C-suite", and a null
//      known_at_company is not "you knew nobody". Where a field is missing,
//      the sentence is dropped, not softened.
//
// What a "reply" means here is decided in one place and it is not this file:
// netlify/functions/lib/outreachApproach.js writes replied_at, and only for a
// message that already passed the auto-reply and bounce gates in emailIngest.
// This function reads the verdict. It never re-derives it, so there is no
// second definition of "answered" to drift out of step with the first.

const C_SUITE = 'c_suite'

// The null check is not defensive tidiness. `new Date(null)` is the epoch, not
// an invalid date, so a Number.isFinite guard alone reads every unanswered
// approach as having been answered in 1970 — which turned every count in the
// first run of these tests into "all of them replied".
function toMs(value) {
  if (value === null || value === undefined || value === '') return null
  const t = new Date(value).getTime()
  return Number.isFinite(t) ? t : null
}

// The calendar month the reader is in, in UTC — the same clock the sent_at
// timestamps are stored on. Deliberately a calendar month rather than a
// rolling 30 days: "this month" is a period a recruiter can check against
// their own sent folder, and "the last 30 days" is not.
export function monthWindow(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now)
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
  return { start, end }
}

const hasKnownCount = a => Number.isInteger(a?.known_at_company)
const hasBand = a => typeof a?.seniority_band === 'string' && a.seniority_band.length > 0

// Company names are compared only to count how many DISTINCT companies a set
// of approaches touched. Lowercased and trimmed, nothing cleverer: the server
// already normalised these against the CRM when the approach was recorded, and
// a second, looser normaliser here could merge two real companies and
// under-report the number.
function distinctCompanies(rows) {
  const seen = new Set()
  for (const r of rows) {
    const name = String(r?.company_name || '').trim().toLowerCase()
    if (name) seen.add(name)
  }
  return seen.size
}

/**
 * The observation, or null.
 *
 * At most one, and only the strongest that the data supports in full. Each
 * guard below is doing real work; read them as "what would have to be true for
 * this sentence to be a fact rather than a flourish".
 */
export function observationFor(sent, replies) {
  // Nothing about one reply is a pattern. Two is the smallest honest claim.
  if (replies.length < 2) return null

  // Was there anything to contrast with? If every approach this month went to
  // a company the recruiter already had someone at, then "the replies came
  // from companies where you knew someone" is true of everything and says
  // nothing at all.
  const cold = sent.filter(a => hasKnownCount(a) && a.known_at_company === 0)
  if (!cold.length) return null

  const warmReplies = replies.filter(a => hasKnownCount(a) && a.known_at_company > 0)

  // --- the seniority form ---------------------------------------------------
  // Only when the band is known for EVERY reply. With one band missing,
  // "both C-suite replies" might really be two of three, and the sentence
  // would be quietly wrong in the customer's favour.
  if (replies.every(hasBand)) {
    const cSuite = replies.filter(a => a.seniority_band === C_SUITE)
    if (cSuite.length >= 2 && cSuite.every(a => hasKnownCount(a) && a.known_at_company > 0)) {
      const how = cSuite.length === 2 ? 'Both' : `All ${cSuite.length}`
      return `${how} C-suite replies came from companies where you already knew someone else.`
    }
  }

  // --- the plain form -------------------------------------------------------
  // Every reply came from a company with an existing relationship, and enough
  // cold companies were tried for the silence to mean something.
  if (warmReplies.length === replies.length) {
    const coldCompanies = distinctCompanies(cold)
    if (coldCompanies >= 2) {
      return `Every reply came from a company where you already knew someone else. `
        + `Nobody replied at the ${coldCompanies} companies where you knew no one.`
    }
  }

  return null
}

/**
 * The readout for the top of the feed.
 *
 * @param approaches rows from public.outreach_approaches, as stored
 * @returns { approached, replied, sentences, text } or null when there is
 *          nothing true to say — which is a normal state, not a failure. A
 *          month with no approaches in it gets no line, because the honest
 *          version of that line is "you have not done anything yet", and
 *          nobody needs their own software to tell them so.
 */
export function outreachReadout(approaches = [], { now = new Date() } = {}) {
  const { start, end } = monthWindow(now)

  const sent = (approaches || []).filter(a => {
    const t = toMs(a?.sent_at)
    return t !== null && t >= start && t < end
  })
  if (!sent.length) return null

  // A reply counts against the month its APPROACH was sent in, not the month
  // it arrived. That is what makes the two numbers a pair: the 3 are among the
  // 8, and a reader can check both against the same eight messages.
  const replies = sent.filter(a => toMs(a?.replied_at) !== null)

  const sentences = [
    `You approached ${sent.length} ${sent.length === 1 ? 'person' : 'people'} this month.`,
  ]

  if (replies.length === 0) {
    sentences.push('None have replied yet.')
  } else if (replies.length === sent.length && sent.length > 1) {
    sentences.push(`All ${sent.length} replied.`)
  } else {
    sentences.push(`${replies.length} replied.`)
  }

  const observation = observationFor(sent, replies)
  if (observation) sentences.push(observation)

  return {
    approached: sent.length,
    replied: replies.length,
    sentences,
    text: sentences.join(' '),
  }
}
