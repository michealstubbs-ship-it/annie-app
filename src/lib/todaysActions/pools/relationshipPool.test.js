import { describe, it, expect } from 'vitest'
import { buildRelationshipPool } from './relationshipPool.js'
import { BD_ACTION_SIGNAL_TYPES } from '../eligibility.js'

function daysAgoIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

describe('buildRelationshipPool', () => {
  const contacts = [{ id: 1, company: 'Acme Ltd', status: 'warm' }]

  it('only includes signals about companies already in the contact list', () => {
    const signals = [{ id: 's1', company_name: 'Unknown Co', status: 'new', signal_type: 'live_job', found_at: daysAgoIso(1) }]
    expect(buildRelationshipPool(signals, contacts)).toEqual([])
  })

  it('excludes signals older than the freshness window even for a known company', () => {
    const signals = [{ id: 's1', company_name: 'Acme Ltd', status: 'new', signal_type: 'live_job', found_at: daysAgoIso(30) }]
    expect(buildRelationshipPool(signals, contacts)).toEqual([])
  })

  it('includes a fresh, whitelisted signal about a known company', () => {
    const signals = [{ id: 's1', company_name: 'Acme Ltd', status: 'new', signal_type: 'live_job', found_at: daysAgoIso(1) }]
    const pool = buildRelationshipPool(signals, contacts)
    expect(pool).toHaveLength(1)
    expect(pool[0].contact).toEqual(contacts[0])
  })

  it('excludes signals already marked actioned', () => {
    const signals = [{ id: 's1', company_name: 'Acme Ltd', status: 'actioned', signal_type: 'live_job', found_at: daysAgoIso(1) }]
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

  it('a manually-added signal clears the freshness window even when otherwise too old', () => {
    const signals = [{ id: 's1', company_name: 'Acme Ltd', status: 'new', signal_type: 'live_job', found_at: daysAgoIso(90), manually_added_at: daysAgoIso(0) }]
    expect(buildRelationshipPool(signals, contacts)).toHaveLength(1)
  })

  it.each(['m_and_a', 'hiring_activity', 'public_commentary', 'team_building', 'job_posting_unclaimed', 'regulatory'])(
    'excludes a fresh %s signal about a known company — only the whitelisted BD types belong here',
    (signal_type) => {
      const signals = [{ id: 's1', company_name: 'Acme Ltd', status: 'new', signal_type, found_at: daysAgoIso(1) }]
      expect(buildRelationshipPool(signals, contacts)).toEqual([])
    }
  )

  it.each(['m_and_a', 'hiring_activity', 'public_commentary', 'regulatory'])(
    '2026-08-25: includes a %s signal when manually added — the whitelist IS bypassed by an explicit Feed add',
    (signal_type) => {
      const signals = [{ id: 's1', company_name: 'Acme Ltd', status: 'new', signal_type, found_at: daysAgoIso(1), manually_added_at: daysAgoIso(0) }]
      expect(buildRelationshipPool(signals, contacts)).toHaveLength(1)
    }
  )

  it.each(BD_ACTION_SIGNAL_TYPES)('includes a fresh %s signal about a known company — the whitelisted types all surface here', (signal_type) => {
    const signals = [{ id: 's1', company_name: 'Acme Ltd', status: 'new', signal_type, found_at: daysAgoIso(1) }]
    expect(buildRelationshipPool(signals, contacts)).toHaveLength(1)
  })

  // 2026-09-01, real report: Michael added Mohammed to the CRM and got three
  // near-identical "Fasset unicorn" relationship cards — three separate
  // intelligence_signals rows about the same real event. This is the
  // defense-in-depth backstop (scanShared.js's fundingFuzzyKey is the actual
  // write-time fix) — this pool should never show more than one card per
  // company no matter how many eligible signal rows exist about it.
  describe('collapses multiple signals about the same company to one, keeping the best one', () => {
    it('collapses two signals for the same company into a single card', () => {
      const signals = [
        { id: 's1', company_name: 'Acme Ltd', status: 'new', signal_type: 'funding', found_at: daysAgoIso(1) },
        { id: 's2', company_name: 'Acme Ltd', status: 'new', signal_type: 'funding', found_at: daysAgoIso(2) },
      ]
      const pool = buildRelationshipPool(signals, contacts)
      expect(pool).toHaveLength(1)
    })

    it('keeps the higher-scoring signal when collapsing (fresher/leadership beats older/plain)', () => {
      const signals = [
        { id: 'older', company_name: 'Acme Ltd', status: 'new', signal_type: 'funding', found_at: daysAgoIso(10) },
        { id: 'leadership', company_name: 'Acme Ltd', status: 'new', signal_type: 'leadership_change', found_at: daysAgoIso(1) },
      ]
      const pool = buildRelationshipPool(signals, contacts)
      expect(pool).toHaveLength(1)
      expect(pool[0].signal.id).toBe('leadership')
    })

    it('does not collapse signals about genuinely different companies', () => {
      const twoCompanyContacts = [{ id: 1, company: 'Acme Ltd', status: 'warm' }, { id: 2, company: 'Globex', status: 'warm' }]
      const signals = [
        { id: 's1', company_name: 'Acme Ltd', status: 'new', signal_type: 'funding', found_at: daysAgoIso(1) },
        { id: 's2', company_name: 'Globex', status: 'new', signal_type: 'funding', found_at: daysAgoIso(1) },
      ]
      const pool = buildRelationshipPool(signals, twoCompanyContacts)
      expect(pool).toHaveLength(2)
    })
  })
})
