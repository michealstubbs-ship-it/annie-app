// Regression tests for Today's Actions' deterministic scoring, the audit's
// M2 finding: unactioned "sourced" signals asymptote to a score floor above
// the inclusion threshold and never age out on their own. These tests pin
// today's actual behaviour and give the eventual age-cutoff fix something
// concrete to change.
import { describe, it, expect } from 'vitest'
import {
  buildDormantPool, buildRelationshipPool, buildSourcedPool, buildNewClientPool, selectDailyItems,
} from './actionsEngine.js'

function daysAgoIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

describe('buildDormantPool', () => {
  it('excludes contacts contacted recently', () => {
    const contacts = [{ id: 1, status: 'warm', last_contacted: daysAgoIso(5) }]
    expect(buildDormantPool(contacts)).toEqual([])
  })

  it('includes a contact silent well past the dormant threshold', () => {
    const contacts = [{ id: 1, status: 'warm', company: 'Acme', last_contacted: daysAgoIso(90) }]
    const pool = buildDormantPool(contacts)
    expect(pool).toHaveLength(1)
    expect(pool[0].score).toBeGreaterThan(0)
  })

  it('excludes client and inactive statuses regardless of staleness', () => {
    const contacts = [
      { id: 1, status: 'client', last_contacted: daysAgoIso(400) },
      { id: 2, status: 'inactive', last_contacted: daysAgoIso(400) },
    ]
    expect(buildDormantPool(contacts)).toEqual([])
  })
})

describe('buildRelationshipPool', () => {
  const contacts = [{ id: 1, company: 'Acme Ltd', status: 'warm' }]

  it('only includes signals about companies already in the contact list', () => {
    const signals = [{ id: 's1', company_name: 'Unknown Co', status: 'new', found_at: daysAgoIso(1) }]
    expect(buildRelationshipPool(signals, contacts)).toEqual([])
  })

  it('excludes signals older than the freshness window even for a known company', () => {
    const signals = [{ id: 's1', company_name: 'Acme Ltd', status: 'new', found_at: daysAgoIso(30) }]
    expect(buildRelationshipPool(signals, contacts)).toEqual([])
  })

  it('includes a fresh signal about a known company', () => {
    const signals = [{ id: 's1', company_name: 'Acme Ltd', status: 'new', found_at: daysAgoIso(1) }]
    const pool = buildRelationshipPool(signals, contacts)
    expect(pool).toHaveLength(1)
    expect(pool[0].contact).toEqual(contacts[0])
  })

  it('excludes signals already marked actioned', () => {
    const signals = [{ id: 's1', company_name: 'Acme Ltd', status: 'actioned', found_at: daysAgoIso(1) }]
    expect(buildRelationshipPool(signals, contacts)).toEqual([])
  })
})

describe('buildSourcedPool — the M2 "never ages out" behaviour', () => {
  it('an unactioned signal keeps scoring above MIN_SCORE (20) no matter how old it gets', () => {
    // This pins the audit's exact finding: score decays toward an additive
    // floor (25, or 40 if contact-verified) rather than toward zero, so it
    // never naturally drops below the 20-point inclusion bar. A future fix
    // that adds an explicit age cutoff (matching buildRelationshipPool's
    // SIGNAL_FRESH_DAYS) should make this test start failing — that's the
    // point, it documents the behaviour so the fix is deliberate, not
        // accidental.
    const veryOldSignal = [{ id: 's1', company_name: 'Unknown Co', status: 'new', found_at: daysAgoIso(400), contact_verified: false, signal_type: 'funding' }]
    const pool = buildSourcedPool(veryOldSignal, [])
    expect(pool[0].score).toBeGreaterThanOrEqual(20)
  })

  it('excludes signals about companies already in the contact list (belongs to relationship pool instead)', () => {
    const contacts = [{ id: 1, company: 'Acme Ltd' }]
    const signals = [{ id: 's1', company_name: 'Acme Ltd', status: 'new', found_at: daysAgoIso(1) }]
    expect(buildSourcedPool(signals, contacts)).toEqual([])
  })

  it('a contact-verified signal scores higher than an otherwise-identical unverified one', () => {
    const base = { id: 's1', company_name: 'Unknown Co', status: 'new', found_at: daysAgoIso(1), signal_type: 'funding' }
    const [unverified] = buildSourcedPool([{ ...base, contact_verified: false }], [])
    const [verified] = buildSourcedPool([{ ...base, contact_verified: true }], [])
    expect(verified.score).toBeGreaterThan(unverified.score)
  })
})

describe('buildNewClientPool', () => {
  it('excludes a hot/warm contact that already has an active deal', () => {
    const contacts = [{ id: 1, status: 'hot', company: 'Acme Ltd' }]
    const deals = [{ company: 'Acme Ltd', stage: 'approached' }]
    expect(buildNewClientPool(contacts, deals)).toEqual([])
  })

  it('includes a hot contact with no active deal', () => {
    const contacts = [{ id: 1, status: 'hot', company: 'Acme Ltd', last_contacted: daysAgoIso(1) }]
    expect(buildNewClientPool(contacts, [])).toHaveLength(1)
  })
})

describe('selectDailyItems', () => {
  it('filters out anything below MIN_SCORE and sorts urgency first, then score', () => {
    const pools = {
      a: [{ category: 'x', score: 10, urgency: 0 }], // below bar, excluded
      b: [{ category: 'x', score: 50, urgency: 0 }],
      c: [{ category: 'x', score: 30, urgency: 1 }], // lower score but higher urgency, should rank first
    }
    const result = selectDailyItems(pools)
    expect(result).toHaveLength(2)
    expect(result[0].urgency).toBe(1)
    expect(result[1].score).toBe(50)
  })
})
