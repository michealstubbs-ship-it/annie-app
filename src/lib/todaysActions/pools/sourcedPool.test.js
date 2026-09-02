import { describe, it, expect } from 'vitest'
import { buildSourcedPool } from './sourcedPool.js'
import { BD_ACTION_SIGNAL_TYPES } from '../eligibility.js'

function daysAgoIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

// A minimal signal that clears every gate except the ones a given test is
// exercising: whitelisted type, a contact candidate (so the "always has
// someone to approach" rule doesn't also exclude it), and fresh.
function baseSignal(overrides = {}) {
  return {
    id: 's1',
    company_name: 'Unknown Co',
    status: 'new',
    signal_type: 'live_job',
    found_at: daysAgoIso(1),
    contact_verified: false,
    contact_candidates: [{ name: 'Jane Doe' }],
    ...overrides,
  }
}

describe('buildSourcedPool — signal-type whitelist (2026-08-27: restored to all four)', () => {
  it.each(BD_ACTION_SIGNAL_TYPES)('includes a fresh, contact-backed %s signal', (signal_type) => {
    const pool = buildSourcedPool([baseSignal({ signal_type })], [])
    expect(pool).toHaveLength(1)
  })

  it.each(['m_and_a', 'hiring_activity', 'public_commentary', 'team_building', 'job_posting_unclaimed', 'regulatory'])(
    'excludes a fresh, contact-backed %s signal — not a BD action type',
    (signal_type) => {
      expect(buildSourcedPool([baseSignal({ signal_type })], [])).toEqual([])
    }
  )

  it('2026-08-25: a manual "Add to Today\'s BD Actions" click DOES bypass the whitelist, as long as it still has a real contact', () => {
    const signals = [baseSignal({ signal_type: 'm_and_a', manually_added_at: daysAgoIso(0) })]
    expect(buildSourcedPool(signals, [])).toHaveLength(1)
  })
})

describe('buildSourcedPool — a BD action always has someone real to approach', () => {
  const base = { id: 's1', company_name: 'DP World', status: 'new', found_at: daysAgoIso(1), signal_type: 'leadership_change' }

  it('excludes a signal with no verified contact and no contact candidates', () => {
    expect(buildSourcedPool([{ ...base, contact_verified: false, contact_candidates: [] }], [])).toEqual([])
  })

  it('excludes a signal where contact_candidates is missing entirely, not just empty', () => {
    expect(buildSourcedPool([{ ...base, contact_verified: false }], [])).toEqual([])
  })

  it('includes a signal with a single verified contact, even with no candidate panel', () => {
    expect(buildSourcedPool([{ ...base, contact_verified: true, contact_candidates: [] }], [])).toHaveLength(1)
  })

  it('includes a signal with at least one contact candidate, even when not itself contact_verified', () => {
    expect(buildSourcedPool([{ ...base, contact_verified: false, contact_candidates: [{ name: 'Jane Doe', function: 'commercial' }] }], [])).toHaveLength(1)
  })

  it('still excludes a contact-less signal even when manually added', () => {
    const signals = [{ ...base, contact_verified: false, contact_candidates: [], manually_added_at: daysAgoIso(0) }]
    expect(buildSourcedPool(signals, [])).toEqual([])
  })
})

describe('buildSourcedPool — age cutoffs and scoring', () => {
  it('excludes a signal past the age cutoff entirely, rather than letting it score forever', () => {
    const veryOld = [baseSignal({ found_at: daysAgoIso(400) })]
    expect(buildSourcedPool(veryOld, [])).toEqual([])
  })

  it('a manually-added signal clears the age cutoff even when otherwise past it', () => {
    const veryOldButChosen = [baseSignal({ found_at: daysAgoIso(400), manually_added_at: daysAgoIso(0) })]
    expect(buildSourcedPool(veryOldButChosen, [])).toHaveLength(1)
  })

  it('leadership_change gets a wider age cutoff (60 days) than live_job\'s 21', () => {
    const oldLeadership = [baseSignal({ signal_type: 'leadership_change', found_at: daysAgoIso(45) })]
    const oldLiveJob = [baseSignal({ signal_type: 'live_job', found_at: daysAgoIso(45) })]
    expect(buildSourcedPool(oldLeadership, [])).toHaveLength(1)
    expect(buildSourcedPool(oldLiveJob, [])).toEqual([])
  })

  it('excludes signals about companies already in the contact list (belongs to relationship pool instead)', () => {
    const contacts = [{ id: 1, company: 'Acme Ltd' }]
    const signals = [baseSignal({ company_name: 'Acme Ltd' })]
    expect(buildSourcedPool(signals, contacts)).toEqual([])
  })

  it('a contact-verified signal scores higher than an otherwise-identical unverified one', () => {
    const [unverified] = buildSourcedPool([baseSignal({ contact_verified: false })], [])
    const [verified] = buildSourcedPool([baseSignal({ contact_verified: true })], [])
    expect(verified.score).toBeGreaterThan(unverified.score)
  })

  it('a live_job entry stays urgent up to 7 days old', () => {
    const [recent] = buildSourcedPool([baseSignal({ found_at: daysAgoIso(6) })], [])
    expect(recent.urgency).toBe(2)
  })

  it('a leadership_change entry stays urgency 2 well past the ordinary window, up to 60 days', () => {
    const [fresh] = buildSourcedPool([baseSignal({ signal_type: 'leadership_change', found_at: daysAgoIso(1) })], [])
    const [older] = buildSourcedPool([baseSignal({ signal_type: 'leadership_change', found_at: daysAgoIso(45) })], [])
    expect(fresh.urgency).toBe(2)
    expect(older.urgency).toBe(2)
  })

  it('excludes signals already marked actioned', () => {
    expect(buildSourcedPool([baseSignal({ status: 'actioned' })], [])).toEqual([])
  })
})

// 2026-09-01, same real report as relationshipPool.test.js's equivalent
// block (Fasset showing 3 times) — this pool has the identical missing-
// collapse gap for brand-new (not-yet-CRM) companies.
describe('buildSourcedPool — collapses multiple signals about the same company to one, keeping the best one', () => {
  it('collapses two signals for the same company into a single card', () => {
    const signals = [
      baseSignal({ id: 's1', found_at: daysAgoIso(1) }),
      baseSignal({ id: 's2', found_at: daysAgoIso(2) }),
    ]
    expect(buildSourcedPool(signals, [])).toHaveLength(1)
  })

  it('keeps the higher-scoring signal when collapsing (contact-verified beats unverified)', () => {
    const signals = [
      baseSignal({ id: 'unverified', contact_verified: false, found_at: daysAgoIso(1) }),
      baseSignal({ id: 'verified', contact_verified: true, found_at: daysAgoIso(1) }),
    ]
    const pool = buildSourcedPool(signals, [])
    expect(pool).toHaveLength(1)
    expect(pool[0].signal.id).toBe('verified')
  })

  it('does not collapse signals about genuinely different companies', () => {
    const signals = [
      baseSignal({ id: 's1', company_name: 'Unknown Co' }),
      baseSignal({ id: 's2', company_name: 'Other Co' }),
    ]
    expect(buildSourcedPool(signals, [])).toHaveLength(2)
  })
})

// 2026-09-02 audit fix, real report: a "Quik Hire Staffing" live_job lead
// kept surfacing after the write-time agency check (scanShared.js) shipped,
// because that check only stops a NEW bad signal from being written — a
// stale row already in the table from before the fix never gets retired on
// its own. Same check now applied here too, so it can never resurface
// regardless of when the row was written.
describe('buildSourcedPool — drops a live_job lead posted by a staffing/recruitment agency', () => {
  it('drops a live_job signal whose company name reads as a staffing agency', () => {
    expect(buildSourcedPool([baseSignal({ company_name: 'Quik Hire Staffing' })], [])).toEqual([])
  })

  it('drops a live_job signal whose company_industry reads as staffing/recruiting, even with an innocuous name', () => {
    expect(buildSourcedPool([baseSignal({ company_name: 'Meridian Partners', company_industry: 'Staffing & Recruiting' })], [])).toEqual([])
  })

  it('does not drop a non-live_job signal from the same agency-named company', () => {
    const signals = [baseSignal({ signal_type: 'funding', company_name: 'Quik Hire Staffing' })]
    expect(buildSourcedPool(signals, [])).toHaveLength(1)
  })

  it('does not drop a genuine live_job lead with no agency signal in name or industry', () => {
    const signals = [baseSignal({ company_name: 'DP World', company_industry: 'Logistics' })]
    expect(buildSourcedPool(signals, [])).toHaveLength(1)
  })
})
