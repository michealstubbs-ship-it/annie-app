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

  it('gives a leadership_change signal a wider freshness window (60 days) than the ordinary 14-day one', () => {
    const signals = [{ id: 's1', company_name: 'Acme Ltd', status: 'new', signal_type: 'leadership_change', found_at: daysAgoIso(30) }]
    const pool = buildRelationshipPool(signals, contacts)
    expect(pool).toHaveLength(1)
    expect(pool[0].urgency).toBe(2)
  })

  it('still excludes a leadership_change signal well past even its own wider window', () => {
    const signals = [{ id: 's1', company_name: 'Acme Ltd', status: 'new', signal_type: 'leadership_change', found_at: daysAgoIso(90) }]
    expect(buildRelationshipPool(signals, contacts)).toEqual([])
  })
})

describe('buildSourcedPool — the M2 "never ages out" fix', () => {
  it('excludes a signal past SOURCED_MAX_AGE_DAYS entirely, rather than letting it score forever', () => {
    // This used to pin the audit's exact finding: score decayed toward an
    // additive floor (25, or 40 if contact-verified) rather than toward
    // zero, so a very old signal never naturally dropped below the 20-point
    // inclusion bar — it just sat there competing for a slot forever. Now
    // it's excluded outright once it's older than the cutoff.
    const veryOldSignal = [{ id: 's1', company_name: 'Unknown Co', status: 'new', found_at: daysAgoIso(400), contact_verified: false, signal_type: 'funding' }]
    expect(buildSourcedPool(veryOldSignal, [])).toEqual([])
  })

  it('still includes a genuinely fresh signal', () => {
    const freshSignal = [{ id: 's1', company_name: 'Unknown Co', status: 'new', found_at: daysAgoIso(2), contact_verified: false, signal_type: 'funding' }]
    const pool = buildSourcedPool(freshSignal, [])
    expect(pool).toHaveLength(1)
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

  it('a live_job entry scores higher than an otherwise-identical generic signal — a specific real open role is the strongest lead this pool surfaces', () => {
    const base = { id: 's1', company_name: 'Unknown Co', status: 'new', found_at: daysAgoIso(1), contact_verified: false }
    const [generic] = buildSourcedPool([{ ...base, signal_type: 'funding' }], [])
    const [liveJob] = buildSourcedPool([{ ...base, signal_type: 'live_job' }], [])
    expect(liveJob.score).toBeGreaterThan(generic.score)
  })

  it('a live_job entry still counts as urgent up to 7 days old, wider than the 3-day window an ordinary racy signal gets — a real open req stays live longer than a news mention', () => {
    const base = { id: 's1', company_name: 'Unknown Co', status: 'new', signal_type: 'live_job', contact_verified: false }
    const [recent] = buildSourcedPool([{ ...base, found_at: daysAgoIso(6) }], [])
    expect(recent.urgency).toBe(2)
  })

  it('an ordinary racy signal (hiring_activity) drops to urgency 1 past 3 days, unlike live_job', () => {
    const base = { id: 's1', company_name: 'Unknown Co', status: 'new', signal_type: 'hiring_activity', contact_verified: false }
    const [older] = buildSourcedPool([{ ...base, found_at: daysAgoIso(6) }], [])
    expect(older.urgency).toBe(1)
  })

  it('a leadership_change entry scores higher than an otherwise-identical generic signal — a new leader is a high-value opportunity', () => {
    const base = { id: 's1', company_name: 'Unknown Co', status: 'new', found_at: daysAgoIso(1), contact_verified: false }
    const [generic] = buildSourcedPool([{ ...base, signal_type: 'funding' }], [])
    const [leadership] = buildSourcedPool([{ ...base, signal_type: 'leadership_change' }], [])
    expect(leadership.score).toBeGreaterThan(generic.score)
  })

  it('a leadership_change entry stays urgency 2 well past the 3-7 day window ordinary signals get, up to 60 days', () => {
    const base = { id: 's1', company_name: 'Unknown Co', status: 'new', signal_type: 'leadership_change', contact_verified: false }
    const [fresh] = buildSourcedPool([{ ...base, found_at: daysAgoIso(1) }], [])
    const [older] = buildSourcedPool([{ ...base, found_at: daysAgoIso(45) }], [])
    expect(fresh.urgency).toBe(2)
    expect(older.urgency).toBe(2)
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
