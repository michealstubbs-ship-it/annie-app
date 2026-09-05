import { describe, it, expect } from 'vitest'
import {
  employerKey,
  deskKey,
  deskKeys,
  ownEmployerVerdicts,
  employerPenalty,
  describeEmployerSignal,
  MIN_DISTINCT_CUSTOMERS,
  MAX_EMPLOYER_PENALTY,
  PARK_DECAY_DAYS,
} from './employerSignal.js'

const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString()

describe('employerKey — what may become a pooled fact about a company', () => {
  it('uses the same normalisation the stream already matches companies with', () => {
    // Not a second implementation: normalizeCompanyName is the one that
    // already decides "Khazna Data Centers" and "Khazna Data Centers PJSC"
    // are the same company. A pooled key that disagreed with it would put
    // the votes on one row and the leads on another.
    expect(employerKey('Khazna Data Centers PJSC')).toBe(employerKey('Khazna Data Centers'))
  })

  it('refuses a placeholder, so "Confidential" can never become the most-parked employer in the pool', () => {
    // FEED-1, Michael: "Confidential is not a company." Eight rows on the
    // measured account carried it, and LinkedIn writes it whenever a member
    // hides their employer. Left in, it would collect parks from every
    // customer in the product within a week and then apply a penalty to every
    // genuine lead whose name happened to normalise to the same string.
    expect(employerKey('Confidential')).toBeNull()
    expect(employerKey('Confidential - Government Entity')).toBeNull()
    expect(employerKey('Stealth Startup')).toBeNull()
    expect(employerKey('')).toBeNull()
  })

  it('refuses anything the table would reject anyway, rather than sending it', () => {
    expect(employerKey('a')).toBeNull()
    expect(employerKey('x'.repeat(200))).toBeNull()
  })
})

describe('deskKey — the segment a vote is filed under', () => {
  it('slugs the onboarding function labels, which are the vocabulary the customer already chose from', () => {
    expect(deskKey('Finance & Accounting')).toBe('finance-accounting')
    expect(deskKey('Construction & Built Environment')).toBe('construction-built-environment')
  })

  it('returns null rather than an empty or malformed desk', () => {
    expect(deskKey('')).toBeNull()
    expect(deskKey(null)).toBeNull()
    expect(deskKey('&')).toBeNull()
  })

  it('de-duplicates and preserves the order the recruiter chose', () => {
    expect(deskKeys(['Finance & Accounting', 'Technology & Data', 'Finance & Accounting']))
      .toEqual(['finance-accounting', 'technology-data'])
  })

  it('gives a customer who chose nothing no desk, which switches the whole feature off for them', () => {
    // Deliberate. An unsegmented vote pools a finance recruiter's judgment
    // with a construction recruiter's, and that is the precise mechanism by
    // which learning from other customers would make Annie narrower.
    expect(deskKeys([])).toEqual([])
    expect(deskKeys(undefined)).toEqual([])
  })
})

describe('ownEmployerVerdicts — reading a customer\'s own outcome log', () => {
  it('turns parks into one verdict per employer, however many times they parked', () => {
    // One vote per customer per company is enforced by the primary key too.
    // This is the same rule stated on the way in, so a recruiter clearing the
    // same company five times does not even send five things.
    const verdicts = ownEmployerVerdicts([
      { company_name: 'Aldar Properties', stage: 'parked', created_at: daysAgo(1) },
      { company_name: 'Aldar Properties', stage: 'parked', created_at: daysAgo(2) },
      { company_name: 'Aldar Properties PJSC', stage: 'parked', created_at: daysAgo(3) },
    ])
    expect(verdicts.size).toBe(1)
    expect([...verdicts.values()]).toEqual(['parked'])
  })

  it('lets one worked lead outweigh any number of parks at the same employer', () => {
    // Evidence that real business happened beats evidence that somebody
    // triaged a card on a Tuesday, and the asymmetry biases the pool against
    // suppressing employers, which is the failure mode that matters.
    const verdicts = ownEmployerVerdicts([
      { company_name: 'NEOM', stage: 'parked', created_at: daysAgo(5) },
      { company_name: 'NEOM', stage: 'parked', created_at: daysAgo(4) },
      { company_name: 'NEOM', stage: 'worked', created_at: daysAgo(3) },
      { company_name: 'NEOM', stage: 'parked', created_at: daysAgo(1) },
    ])
    expect(verdicts.get('neom')).toBe('worked')
  })

  it('counts a placement as worked — it is the same customer saying the same thing', () => {
    const verdicts = ownEmployerVerdicts([{ company_name: 'ADQ', stage: 'placed', created_at: daysAgo(1) }])
    expect(verdicts.get('adq')).toBe('worked')
  })

  it('ignores seen and dismissed, and dismissed for a reason', () => {
    // 'seen' is not a judgment at all. 'dismissed' is one, but about the
    // SIGNAL — it is already counted against the shared signal by the
    // signal_pool trigger (2026-08-27-signal-pool-quality-feedback.sql).
    // Counting it here too would feed one click into two learners and make a
    // bad source look like a bad company.
    const verdicts = ownEmployerVerdicts([
      { company_name: 'Investcorp', stage: 'seen', created_at: daysAgo(1) },
      { company_name: 'Investcorp', stage: 'dismissed', created_at: daysAgo(1) },
    ])
    expect(verdicts.size).toBe(0)
  })

  it('drops evidence older than the decay window, so a company gets a fresh hearing', () => {
    // Companies change: new leadership, new funding, a hiring freeze that
    // ended. A permanent record would also mean the pool could only ever grow
    // more negative as Annie got older, which is the narrowing failure again
    // wearing a different hat.
    const verdicts = ownEmployerVerdicts([
      { company_name: 'Old Money Holdings', stage: 'parked', created_at: daysAgo(PARK_DECAY_DAYS + 10) },
      { company_name: 'Recent Ltd', stage: 'parked', created_at: daysAgo(3) },
    ])
    expect(verdicts.has('recent')).toBe(true)
    expect(verdicts.size).toBe(1)
  })

  it('carries nothing but a company key and one of two words', () => {
    // THE BOUNDARY. This return value is everything that crosses a tenant
    // boundary. Michael, 2026-09-05: "share the fact about the ORGANISATION,
    // never the record about the PERSON."
    const verdicts = ownEmployerVerdicts([{
      company_name: 'Aldar Properties',
      stage: 'parked',
      created_at: daysAgo(1),
      // Columns this read does not select, present here to prove that even if
      // it did, none of them can reach the pool.
      signal_id: 'sig-1',
      user_id: 'user-1',
      contact_name: 'Sarah Mansour',
    }])
    const serialised = JSON.stringify([...verdicts])
    expect(serialised).not.toContain('Sarah')
    expect(serialised).not.toContain('sig-1')
    expect(serialised).not.toContain('user-1')
    expect([...verdicts.values()].every(v => v === 'parked' || v === 'worked')).toBe(true)
  })
})

describe('employerPenalty — the floor, the cap, and the reason it is a share', () => {
  it('does nothing at all below the distinct-customer floor', () => {
    // Three was rejected: one tenant is a third of the evidence, and two
    // customers who happen to share a taste look like a consensus. It is also
    // the k in the k-anonymity argument — the SQL reader returns nothing
    // below it, so no aggregate can be traced to one customer's behaviour.
    expect(MIN_DISTINCT_CUSTOMERS).toBe(4)
    expect(employerPenalty({ parkedVoters: 3, workedVoters: 0 })).toBe(0)
    expect(employerPenalty({ parkedVoters: 4, workedVoters: 0 })).toBeGreaterThan(0)
  })

  it('does nothing when the pool has no opinion at all', () => {
    expect(employerPenalty(null)).toBe(0)
    expect(employerPenalty(undefined)).toBe(0)
    expect(employerPenalty({})).toBe(0)
  })

  it('does nothing when recruiters disagree', () => {
    // Half parked, half worked is not "bad employer", it is "recruiters
    // disagree" — which is exactly Michael's case for the weight being a
    // weight: a firm wrong for one recruiter may be right for a contingency
    // recruiter on smaller roles.
    expect(employerPenalty({ parkedVoters: 5, workedVoters: 5 })).toBe(0)
    expect(employerPenalty({ parkedVoters: 4, workedVoters: 6 })).toBe(0)
  })

  it('caps at MAX_EMPLOYER_PENALTY however unanimous the pool gets', () => {
    expect(employerPenalty({ parkedVoters: 4, workedVoters: 0 })).toBe(MAX_EMPLOYER_PENALTY)
    expect(employerPenalty({ parkedVoters: 4000, workedVoters: 0 })).toBe(MAX_EMPLOYER_PENALTY)
  })

  it('scores the SHARE, not the count — which is what stops Annie narrowing as she grows', () => {
    // THE ANTI-NARROWING PROPERTY, asserted rather than described. If the
    // penalty grew with the number of parks, every new customer would push
    // every employer further down, the feed would converge on a shrinking set
    // of "good" companies, and every customer would end up chasing the same
    // shortlist as their competitors. Ten thousand customers splitting 60/40
    // must produce exactly the weight ten of them do.
    const small = employerPenalty({ parkedVoters: 6, workedVoters: 4 })
    const large = employerPenalty({ parkedVoters: 6000, workedVoters: 4000 })
    expect(large).toBe(small)
    expect(small).toBeGreaterThan(0)
  })

  it('ramps rather than cliff-edges, so a 60/40 split is not treated like a 100/0 one', () => {
    const mild = employerPenalty({ parkedVoters: 6, workedVoters: 4 })
    const strong = employerPenalty({ parkedVoters: 9, workedVoters: 1 })
    expect(mild).toBeLessThan(strong)
    expect(strong).toBeLessThan(MAX_EMPLOYER_PENALTY)
  })

  it('stays a weight rather than a ban: the cap is smaller than one rung of the way-in ladder', () => {
    // RUNG_WEIGHT in buildStream.js is 0 / 12 / 25 / 40. The smallest gap is
    // 12. A cap of 10 therefore cannot push a lead you have a route into
    // below one you do not, whatever the pool thinks of the employer.
    expect(MAX_EMPLOYER_PENALTY).toBeLessThan(12)
  })
})

describe('describeEmployerSignal', () => {
  it('says how many CUSTOMERS, never who, and never the word avoid', () => {
    const text = describeEmployerSignal({ parkedVoters: 6, workedVoters: 1 })
    expect(text).toContain('6 recruiters')
    expect(text).toContain('one of them has worked a lead')
    expect(text.toLowerCase()).not.toContain('avoid')
  })

  it('says nothing at all when the weight is doing nothing', () => {
    expect(describeEmployerSignal({ parkedVoters: 3, workedVoters: 0 })).toBeNull()
    expect(describeEmployerSignal(null)).toBeNull()
  })
})
