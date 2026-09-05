import { describe, it, expect } from 'vitest'
import { outreachReadout, observationFor, monthWindow } from './outreachReadout.js'

// The rules being defended here are copy rules, not arithmetic, so most of
// these tests assert on strings. That is deliberate: Michael has rejected
// drafts for breaking exactly these, and a test that only checked the counts
// would pass on a readout that said "You're on a 38% reply rate — keep it up!"
//
// The rule, from the head of stream/whyNow.js and restated for this file:
// plain sentences or nothing, never a claim the data does not prove, never a
// motivational metric.

const NOW = new Date('2026-09-20T10:00:00.000Z')

let seq = 0
function approach({ day = 3, replied = null, band = 'director_vp', known = 0, company = 'Acme' } = {}) {
  seq += 1
  return {
    id: `a${seq}`,
    company_name: company,
    sent_at: `2026-09-${String(day).padStart(2, '0')}T09:00:00.000Z`,
    replied_at: replied,
    seniority_band: band,
    known_at_company: known,
  }
}

describe('monthWindow', () => {
  it('is the calendar month, in UTC, because that is what the sent folder shows', () => {
    // A rolling 30 days cannot be checked by hand. "This month" can: the
    // recruiter scrolls their own sent items to the 1st and counts.
    const { start, end } = monthWindow(NOW)
    expect(new Date(start).toISOString()).toBe('2026-09-01T00:00:00.000Z')
    expect(new Date(end).toISOString()).toBe('2026-10-01T00:00:00.000Z')
  })

  it('rolls the year over in December', () => {
    const { end } = monthWindow(new Date('2026-12-14T23:30:00.000Z'))
    expect(new Date(end).toISOString()).toBe('2027-01-01T00:00:00.000Z')
  })
})

describe('outreachReadout — the counts', () => {
  it('says nothing at all when nothing was sent this month', () => {
    // Not an empty state, not a prompt, not a nudge. The honest version of
    // this line is "you have not done anything yet", and a row that says that
    // every morning is a row people learn to skip — which then costs the
    // readout its audience on the day it has something to say.
    expect(outreachReadout([], { now: NOW })).toBeNull()
    expect(outreachReadout([approach({ day: 3 })], { now: new Date('2026-10-04T10:00:00.000Z') })).toBeNull()
  })

  it('counts the approaches and the replies, in whole numbers', () => {
    const rows = [
      approach({ day: 2, replied: '2026-09-04T08:00:00.000Z' }),
      approach({ day: 3 }),
      approach({ day: 5, replied: '2026-09-06T08:00:00.000Z' }),
      approach({ day: 9 }),
    ]
    const got = outreachReadout(rows, { now: NOW })
    expect(got.approached).toBe(4)
    expect(got.replied).toBe(2)
    expect(got.text).toBe('You approached 4 people this month. 2 replied.')
  })

  it('never turns the pair into a rate', () => {
    // Michael's rule, stated as a test because it is the failure mode this
    // feature invites: three replies from eight sends is a fact; "38%" is a
    // score, and a percentage over eight events is noise given a confident
    // shape. Whole counts only.
    const rows = Array.from({ length: 8 }, (_, i) =>
      approach({ day: i + 1, replied: i < 3 ? '2026-09-10T08:00:00.000Z' : null }))
    const got = outreachReadout(rows, { now: NOW })
    expect(got.text).not.toMatch(/%|rate|average|score|streak|keep it up|great|well done/i)
    expect(got.text.startsWith('You approached 8 people this month. 3 replied.')).toBe(true)
  })

  it('says "person" for one', () => {
    const got = outreachReadout([approach({ day: 4 })], { now: NOW })
    expect(got.text).toBe('You approached 1 person this month. None have replied yet.')
  })

  it('does not read silence as failure', () => {
    // "None have replied yet" and not "nobody replied": an approach sent
    // yesterday has not failed, and the readout must not imply it has.
    const got = outreachReadout([approach({ day: 19 }), approach({ day: 19 })], { now: NOW })
    expect(got.text).toContain('None have replied yet.')
  })

  it('says all replied when they all did', () => {
    const rows = [
      approach({ day: 2, replied: '2026-09-03T08:00:00.000Z' }),
      approach({ day: 3, replied: '2026-09-04T08:00:00.000Z' }),
    ]
    expect(outreachReadout(rows, { now: NOW }).text).toBe('You approached 2 people this month. All 2 replied.')
  })

  it('counts a reply against the month the approach was sent in', () => {
    // The two numbers have to be a pair — the 3 must be among the 8 — or a
    // recruiter checking them against their own sent items finds them
    // inconsistent and stops trusting the row.
    const rows = [
      { ...approach({ day: 28 }), sent_at: '2026-08-28T09:00:00.000Z', replied_at: '2026-09-02T09:00:00.000Z' },
      approach({ day: 4 }),
    ]
    const got = outreachReadout(rows, { now: NOW })
    expect(got.approached).toBe(1)
    expect(got.replied).toBe(0)
  })
})

describe('observationFor — the third sentence, and when there is not one', () => {
  const replied = '2026-09-10T08:00:00.000Z'

  it('is the line Michael asked for when the data proves it', () => {
    const rows = [
      approach({ day: 2, replied, band: 'c_suite', known: 3, company: 'TAQA' }),
      approach({ day: 3, replied, band: 'c_suite', known: 1, company: 'Al Akaria' }),
      approach({ day: 4, band: 'director_vp', known: 0, company: 'Limad' }),
      approach({ day: 5, band: 'manager_plus', known: 0, company: 'Jash' }),
    ]
    const got = outreachReadout(rows, { now: NOW })
    expect(got.text).toBe(
      'You approached 4 people this month. 2 replied. '
      + 'Both C-suite replies came from companies where you already knew someone else.'
    )
  })

  it('says nothing about a single reply', () => {
    // One event is not a pattern, and a sentence built on one reads as a
    // finding. Two is the smallest honest claim.
    const rows = [
      approach({ day: 2, replied, band: 'c_suite', known: 4 }),
      approach({ day: 3, band: 'director_vp', known: 0, company: 'Limad' }),
      approach({ day: 4, band: 'director_vp', known: 0, company: 'Jash' }),
    ]
    expect(observationFor(rows, [rows[0]])).toBeNull()
    expect(outreachReadout(rows, { now: NOW }).sentences).toHaveLength(2)
  })

  it('says nothing when every approach went somewhere they already knew someone', () => {
    // "The replies came from companies where you knew someone" is true of the
    // whole month here, so it identifies nothing. Without a cold approach to
    // contrast against it is a sentence that sounds like a finding and is not.
    const rows = [
      approach({ day: 2, replied, band: 'c_suite', known: 2, company: 'TAQA' }),
      approach({ day: 3, replied, band: 'c_suite', known: 5, company: 'Al Akaria' }),
      approach({ day: 4, band: 'director_vp', known: 1, company: 'Limad' }),
    ]
    expect(outreachReadout(rows, { now: NOW }).sentences).toHaveLength(2)
  })

  it('will not call a reply C-suite when another replier has no band recorded', () => {
    // 753 contacts on the production account, imported in bulk; seniority_band
    // is backfilled by a classifier and is genuinely null for some. A null
    // band is UNKNOWN, never "not C-suite" — so "both C-suite replies" here
    // could really be two of three, and the sentence would be wrong in the
    // customer's favour, which is the worst direction to be wrong in.
    const rows = [
      approach({ day: 2, replied, band: 'c_suite', known: 3, company: 'TAQA' }),
      approach({ day: 3, replied, band: 'c_suite', known: 1, company: 'Al Akaria' }),
      approach({ day: 4, replied, band: null, known: 2, company: 'E7 Group' }),
      approach({ day: 5, band: 'director_vp', known: 0, company: 'Limad' }),
      approach({ day: 6, band: 'director_vp', known: 0, company: 'Jash' }),
    ]
    const got = outreachReadout(rows, { now: NOW })
    // It falls through to the plain form, which needs no band at all.
    expect(got.sentences[2]).toBe(
      'Every reply came from a company where you already knew someone else. '
      + 'Nobody replied at the 2 companies where you knew no one.'
    )
  })

  it('falls back to the plain form when the repliers are not C-suite', () => {
    const rows = [
      approach({ day: 2, replied, band: 'director_vp', known: 3, company: 'TAQA' }),
      approach({ day: 3, replied, band: 'manager_plus', known: 1, company: 'Al Akaria' }),
      approach({ day: 4, band: 'c_suite', known: 0, company: 'Limad' }),
      approach({ day: 5, band: 'c_suite', known: 0, company: 'Jash' }),
    ]
    expect(outreachReadout(rows, { now: NOW }).sentences[2]).toBe(
      'Every reply came from a company where you already knew someone else. '
      + 'Nobody replied at the 2 companies where you knew no one.'
    )
  })

  it('counts companies, not messages, when reporting the silent side', () => {
    // Three approaches at one cold company is one company that did not reply,
    // not three. Saying "the 3 companies where you knew no one" when there is
    // one would be a number the recruiter could disprove in a glance.
    const rows = [
      approach({ day: 2, replied, band: 'director_vp', known: 3, company: 'TAQA' }),
      approach({ day: 3, replied, band: 'director_vp', known: 1, company: 'Al Akaria' }),
      approach({ day: 4, band: 'director_vp', known: 0, company: 'Limad' }),
      approach({ day: 5, band: 'director_vp', known: 0, company: 'Limad' }),
      approach({ day: 6, band: 'director_vp', known: 0, company: 'Jash' }),
    ]
    expect(outreachReadout(rows, { now: NOW }).sentences[2]).toContain('the 2 companies where you knew no one')
  })

  it('says nothing when only one cold company was tried', () => {
    // One silent company is one company having a busy fortnight, not a
    // pattern about relationships.
    const rows = [
      approach({ day: 2, replied, band: 'c_suite', known: 3, company: 'TAQA' }),
      approach({ day: 3, replied, band: 'c_suite', known: 1, company: 'Al Akaria' }),
      approach({ day: 4, band: 'director_vp', known: 0, company: 'Limad' }),
    ]
    // The seniority form still holds — it needs a cold approach to exist, not
    // two cold companies — so this asserts the plain form is what is gated.
    const noBands = rows.map(r => ({ ...r, seniority_band: null }))
    expect(observationFor(noBands, noBands.filter(r => r.replied_at))).toBeNull()
  })

  it('says nothing when known_at_company was never recorded', () => {
    // null is "we did not establish this", not zero. An approach whose count
    // failed at send time must not be read as "you knew nobody there".
    const rows = [
      approach({ day: 2, replied, band: 'c_suite', known: null, company: 'TAQA' }),
      approach({ day: 3, replied, band: 'c_suite', known: null, company: 'Al Akaria' }),
      approach({ day: 4, band: 'director_vp', known: null, company: 'Limad' }),
      approach({ day: 5, band: 'director_vp', known: null, company: 'Jash' }),
    ]
    expect(outreachReadout(rows, { now: NOW }).sentences).toHaveLength(2)
  })

  it('says nothing when a cold company also replied', () => {
    // The claim is "every reply came from a company where you knew someone".
    // One reply from a cold company falsifies it outright, and there is no
    // hedged version of the sentence worth printing.
    const rows = [
      approach({ day: 2, replied, band: 'director_vp', known: 3, company: 'TAQA' }),
      approach({ day: 3, replied, band: 'director_vp', known: 0, company: 'Limad' }),
      approach({ day: 4, band: 'director_vp', known: 0, company: 'Jash' }),
      approach({ day: 5, band: 'director_vp', known: 0, company: 'Sanam' }),
    ]
    expect(outreachReadout(rows, { now: NOW }).sentences).toHaveLength(2)
  })

  it('uses no recruitment-marketing language anywhere it can speak', () => {
    // The named offenders, from Michael 2026-09-05: "bench", "new seat",
    // "budget and something to prove", "the warmest call in recruitment".
    const banned = /bench|new seat|something to prove|warmest|warm lead|hot lead|pipeline momentum|touchpoint|cadence|engagement/i
    const rows = [
      approach({ day: 2, replied: '2026-09-10T08:00:00.000Z', band: 'c_suite', known: 3, company: 'TAQA' }),
      approach({ day: 3, replied: '2026-09-11T08:00:00.000Z', band: 'c_suite', known: 1, company: 'Al Akaria' }),
      approach({ day: 4, band: 'director_vp', known: 0, company: 'Limad' }),
      approach({ day: 5, band: 'director_vp', known: 0, company: 'Jash' }),
    ]
    expect(outreachReadout(rows, { now: NOW }).text).not.toMatch(banned)
    expect(outreachReadout([approach({ day: 4 })], { now: NOW }).text).not.toMatch(banned)
  })
})
