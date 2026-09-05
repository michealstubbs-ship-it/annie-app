import { describe, it, expect } from 'vitest'
import { whyNow } from './whyNow'
import { BACKLOG_SIGNAL_TYPE } from './backlogSignals'
import { RUNG_SPOKEN, RUNG_CANDIDATE, RUNG_CONTACT, RUNG_COLD } from './wayIn'

const khazna = [
  { company: 'Khazna Data Centers', seniority_band: 'c_suite' },
  { company: 'Khazna Data Centers', seniority_band: 'c_suite' },
  { company: 'Khazna Data Centers', seniority_band: 'director_vp' },
]

function item(signal = {}, rung = RUNG_CONTACT) {
  return { signal: { company_name: 'Khazna Data Centers', ...signal }, wayIn: { rung } }
}

describe('whyNow', () => {
  // The backlog's whole argument in one sentence: a real relationship you have
  // never used. Nothing changed, and saying so plainly beats manufacturing an
  // event that did not happen.
  it('says the backlog case the way a recruiter would', () => {
    const line = whyNow(item({ signal_type: BACKLOG_SIGNAL_TYPE }), khazna)
    expect(line).toBe('You know 3 people at Khazna Data Centers, 2 of them C-suite, and have never contacted any of them.')
  })

  it('does not claim a C-suite count when there is only one', () => {
    const line = whyNow(item({ signal_type: BACKLOG_SIGNAL_TYPE }), [
      { company: 'Khazna Data Centers', seniority_band: 'c_suite' },
      { company: 'Khazna Data Centers', seniority_band: 'director_vp' },
    ])
    expect(line).toBe('You know 2 people at Khazna Data Centers, and have never contacted any of them.')
  })

  it('handles knowing exactly one person without saying "1 people"', () => {
    const line = whyNow(item({ signal_type: BACKLOG_SIGNAL_TYPE }), [{ company: 'Khazna Data Centers' }])
    expect(line).toBe('You know someone at Khazna Data Centers, and have never contacted any of them.')
  })

  it('leads with the vacated need on a job move', () => {
    const line = whyNow(item({ signal_type: 'leadership_change', linked_contact_id: 'c1' }), khazna)
    expect(line).toContain('live need at a company you can already get into')
  })

  it('says you have spoken to someone when that is the strongest fact', () => {
    expect(whyNow(item({ signal_type: 'live_job' }, RUNG_SPOKEN), khazna))
      .toContain('you have spoken to one of them before')
  })

  it('uses a candidate as the way in when that is what there is', () => {
    expect(whyNow(item({ signal_type: 'live_job' }, RUNG_CANDIDATE), []))
      .toContain('One of your candidates works here')
  })

  // A generic line is worse than none: it trains the reader to skip the row.
  it('returns null rather than a line that says nothing', () => {
    expect(whyNow(item({ signal_type: 'live_job' }, RUNG_COLD), [])).toBeNull()
    expect(whyNow(null, [])).toBeNull()
    expect(whyNow({}, [])).toBeNull()
  })

  // The copy rule, pinned because it was a real correction.
  it('uses none of the language Michael rejected', () => {
    const lines = [
      whyNow(item({ signal_type: BACKLOG_SIGNAL_TYPE }), khazna),
      whyNow(item({ signal_type: 'leadership_change', linked_contact_id: 'c1' }), khazna),
      whyNow(item({ signal_type: 'live_job' }, RUNG_SPOKEN), khazna),
    ].join(' ')
    expect(lines).not.toMatch(/bench|new seat|something to prove|warmest|budget and/i)
  })

  it('matches company names case and space insensitively', () => {
    const line = whyNow(item({ signal_type: BACKLOG_SIGNAL_TYPE, company_name: 'ADQ' }), [
      { company: ' adq ' }, { company: 'ADQ' },
    ])
    expect(line).toContain('2 people at ADQ')
  })

  it('survives a contact list full of junk', () => {
    expect(() => whyNow(item({ signal_type: BACKLOG_SIGNAL_TYPE }), [null, {}, { company: null }])).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// whyPerson — Michael, 2026-09-05: "it doesnt say why to approach this guy."
// ---------------------------------------------------------------------------
import { whyPerson } from './whyNow'

const neom = [
  { name: 'Nader Ashoor', company: 'NEOM', title: 'Chief Strategy Officer', seniority_band: 'c_suite', function_area: 'Strategy & Corporate Development' },
  { name: 'Paul Potgieter', company: 'NEOM', title: 'Chief Information Officer', seniority_band: 'c_suite', function_area: 'Technology' },
  { name: 'Ahmad Alsinan', company: 'NEOM', title: 'Head of Corporate Development', seniority_band: 'director_vp', function_area: 'Strategy & Corporate Development' },
]

describe('whyPerson', () => {
  const functions = ['Strategy & Corporate Development', 'Technology', 'Finance & Accounting']

  it('answers why this person, not why this company', () => {
    const line = whyPerson(neom[0], { company: 'NEOM', contacts: neom, functions })
    expect(line).toContain('A Chief Strategy Officer holds the budget in Strategy & Corporate Development')
    expect(line).toContain('one of the functions you recruit into')
    expect(line).toContain('one of two C-suite people you know at NEOM')
    // A numeral mid-sentence reads like a database field.
    expect(line).not.toMatch(/one of \d/)
    expect(line).toContain('nobody there has been called')
  })

  it('says most senior when they are the only C-suite name there', () => {
    const line = whyPerson(neom[0], { company: 'NEOM', contacts: [neom[0], neom[2]], functions })
    expect(line).toContain('the most senior person you know at NEOM')
  })

  it('does not claim a function fit the customer never asked for', () => {
    const line = whyPerson(neom[1], { company: 'NEOM', contacts: neom, functions: ['Finance & Accounting'] })
    expect(line).not.toContain('one of the functions you recruit into')
    expect(line).toContain('senior enough to open a door in any function')
  })

  it('says so when there is real history at the company', () => {
    const withHistory = neom.map((c, i) => (i === 2 ? { ...c, last_contacted: '2026-07-01' } : c))
    expect(whyPerson(neom[0], { company: 'NEOM', contacts: withHistory, functions }))
      .toContain('you have history at this company')
  })

  // Annie does not know anyone's gender and must never infer one from a name.
  it('uses no pronouns at all', () => {
    const line = whyPerson(neom[0], { company: 'NEOM', contacts: neom, functions })
    expect(line).not.toMatch(/\b(he|she|him|her|his|hers)\b/i)
  })

  it('returns null rather than a line that says nothing', () => {
    expect(whyPerson(null, {})).toBeNull()
    expect(whyPerson({ name: 'A B' }, { company: 'X', contacts: [] })).toBeNull()
  })
})
