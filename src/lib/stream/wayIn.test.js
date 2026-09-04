// The matcher's job is to be RIGHT, not to be generous. Every false-positive
// case below is real: measured on 2026-09-04 against the production account
// holding 753 contacts, substring matching produced 12 hits across 37 signals
// and seven were different companies.
import { describe, it, expect } from 'vitest'
import { companyRelation, computeWayIn, hasRealHistory, RUNG_SPOKEN, RUNG_CANDIDATE, RUNG_CONTACT, RUNG_COLD } from './wayIn.js'

describe('companyRelation — the seven real false positives that must never match again', () => {
  it('does not offer Capital One as a way into Capital Group', () => {
    // The exact failure: normalizeCompanyName strips "group" as a legal
    // suffix, leaving the single token "capital", which is a substring of
    // "capital one".
    expect(companyRelation('Capital Group', 'Capital One')).toBeNull()
  })

  it('does not offer Cypher Capital or Abu Dhabi Capital Group as a way into Capital Group', () => {
    expect(companyRelation('Capital Group', 'Cypher Capital')).toBeNull()
    expect(companyRelation('Capital Group', 'Abu Dhabi Capital Group')).toBeNull()
  })

  it('does not offer a contact at du, the telecom operator, as a way into Commercial Bank of Dubai', () => {
    expect(companyRelation('Commercial Bank of Dubai', 'du')).toBeNull()
  })

  it('does not offer SAGIA or the Ministry of Health as a way into SAMA', () => {
    expect(companyRelation('Saudi Arabia (SAMA)', 'Saudi Arabian General Investment Authority (SAGIA)')).toBeNull()
    expect(companyRelation('Saudi Arabia (SAMA)', 'Ministry of Health Saudi Arabia')).toBeNull()
  })

  it('does not offer a contact at Emirates, the airline, as a way into ALAS Emirates Ready Mix', () => {
    expect(companyRelation('ALAS Emirates Ready Mix L.L.C', 'Emirates')).toBeNull()
  })
})

describe('companyRelation — the genuine matches that must survive', () => {
  it('matches an exact company name', () => {
    expect(companyRelation('Investcorp', 'Investcorp')).toBe('exact')
  })

  it('matches through legal suffixes and punctuation', () => {
    expect(companyRelation('Fasset', 'Fasset')).toBe('exact')
    expect(companyRelation('Aldar Properties', 'Aldar Properties PJSC')).toBe('exact')
  })

  it('matches a subsidiary to its parent group, and flags it as a parent match', () => {
    expect(companyRelation('Al-Futtaim Finance Company', 'Al-Futtaim')).toBe('parent')
  })

  it('matches L\'IMAD inside its own renamed entity', () => {
    expect(companyRelation("L'imad Holding (formerly ADQ)", "L'IMAD")).toBe('parent')
  })

  it('is symmetric', () => {
    expect(companyRelation('Al-Futtaim', 'Al-Futtaim Finance Company')).toBe('parent')
  })

  it('returns null for empty input rather than matching everything', () => {
    expect(companyRelation('', 'Investcorp')).toBeNull()
    expect(companyRelation('Investcorp', null)).toBeNull()
  })
})

describe('hasRealHistory — what earns the right to call something warm', () => {
  it('counts a logged contact date', () => {
    expect(hasRealHistory({ last_contacted: '2026-06-12' })).toBe(true)
  })

  it('counts a note the recruiter wrote', () => {
    expect(hasRealHistory({ notes: 'Spoke about their CFO search' })).toBe(true)
  })

  it('does NOT count a bare imported record', () => {
    // The production account holds 753 contacts and ZERO have either field.
    // Every one arrived by bulk import. companyMatch.js used to call these
    // "a warm door" purely because the company name lined up.
    expect(hasRealHistory({ name: 'Sarah Khan', company: 'Aldar' })).toBe(false)
  })

  it('does not count whitespace as a note', () => {
    expect(hasRealHistory({ notes: '   ' })).toBe(false)
  })
})

describe('computeWayIn — the ladder', () => {
  const signal = { company_name: 'Investcorp', signal_type: 'm_and_a' }

  it('rung 1: a contact they have actually spoken to', () => {
    const result = computeWayIn(signal, {
      contacts: [{ name: 'Varun Sood', company: 'Investcorp', last_contacted: '2026-06-12' }],
    })
    expect(result.rung).toBe(RUNG_SPOKEN)
    expect(result.kind).toBe('spoken')
    expect(result.person.name).toBe('Varun Sood')
    expect(result.caveat).toBeNull()
  })

  it('rung 2: a candidate who works there right now, with the risk named out loud', () => {
    const result = computeWayIn(signal, {
      candidates: [{ name: 'Dana Riaz', company: 'Investcorp', status: 'interviewing' }],
    })
    expect(result.rung).toBe(RUNG_CANDIDATE)
    expect(result.caveat).toMatch(/tread carefully/i)
  })

  it('does not use a candidate who has already been placed or has withdrawn', () => {
    // Michael, 2026-09-04: previous candidates are not a way in.
    for (const status of ['placed', 'rejected', 'withdrawn']) {
      const result = computeWayIn(signal, { candidates: [{ name: 'X', company: 'Investcorp', status }] })
      expect(result.rung).toBe(RUNG_COLD)
    }
  })

  it('rung 3: a contact with no history at all, stated as a bare fact', () => {
    const result = computeWayIn(signal, {
      contacts: [{ name: 'Varun Sood', company: 'Investcorp' }],
    })
    expect(result.rung).toBe(RUNG_CONTACT)
    expect(result.caveat).toMatch(/name rather than a relationship/i)
  })

  it('rung 4: nobody, and the lead is still returned rather than hidden', () => {
    const result = computeWayIn({ company_name: 'Aldar Properties' }, { contacts: [], candidates: [] })
    expect(result.rung).toBe(RUNG_COLD)
    expect(result.person).toBeNull()
  })

  it('prefers a spoken-to contact over a candidate over a bare contact', () => {
    const result = computeWayIn(signal, {
      contacts: [
        { name: 'Bare', company: 'Investcorp' },
        { name: 'Spoken', company: 'Investcorp', notes: 'called them' },
      ],
      candidates: [{ name: 'Insider', company: 'Investcorp', status: 'active' }],
    })
    expect(result.person.name).toBe('Spoken')
  })

  it('prefers an exact company match over a parent-group match', () => {
    const result = computeWayIn({ company_name: 'Al-Futtaim Finance Company' }, {
      contacts: [
        { name: 'Parent Person', company: 'Al-Futtaim', notes: 'x' },
        { name: 'Exact Person', company: 'Al-Futtaim Finance Company', notes: 'x' },
      ],
    })
    expect(result.person.name).toBe('Exact Person')
    expect(result.relation).toBe('exact')
  })

  it('says plainly when the only route in sits in a different entity of the same group', () => {
    const result = computeWayIn({ company_name: 'Al-Futtaim Finance Company' }, {
      contacts: [{ name: 'Karim Moussaoui', company: 'Al-Futtaim' }],
    })
    expect(result.relation).toBe('parent')
    expect(result.caveat).toContain('same group, different entity')
  })

  it('reports the near-misses it rejected, so silence reads as judgement', () => {
    const result = computeWayIn({ company_name: 'Capital Group' }, {
      contacts: [
        { name: 'A', company: 'Capital One' },
        { name: 'B', company: 'Cypher Capital' },
      ],
    })
    expect(result.rung).toBe(RUNG_COLD)
    expect(result.nearMisses).toEqual(expect.arrayContaining(['Capital One', 'Cypher Capital']))
  })

  it('never claims a way in when the signal has no company at all', () => {
    const result = computeWayIn({ company_name: null }, { contacts: [{ name: 'X', company: 'Anything' }] })
    expect(result.rung).toBe(RUNG_COLD)
  })
})
