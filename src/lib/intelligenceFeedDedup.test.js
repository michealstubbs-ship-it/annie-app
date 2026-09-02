import { describe, it, expect } from 'vitest'
import { collapseFeedDuplicates, DEDUP_WINDOW_DAYS } from './intelligenceFeedDedup.js'

function daysAgoIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

function sig(overrides = {}) {
  return {
    id: 's1', company_name: 'DIFC', signal_type: 'expansion', status: 'seen', found_at: daysAgoIso(1),
    headline: 'x', ...overrides,
  }
}

describe('collapseFeedDuplicates', () => {
  it('collapses two rows for the same company+type found close together into one', () => {
    const signals = [
      sig({ id: 'a', found_at: daysAgoIso(1) }),
      sig({ id: 'b', found_at: daysAgoIso(3) }),
    ]
    const result = collapseFeedDuplicates(signals)
    expect(result).toHaveLength(1)
  })

  it('keeps the most recent row of a cluster as its representative', () => {
    const signals = [
      sig({ id: 'older', found_at: daysAgoIso(5) }),
      sig({ id: 'newer', found_at: daysAgoIso(1) }),
    ]
    const result = collapseFeedDuplicates(signals)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('newer')
  })

  // 2026-09-02: the real production spread — worst case seen was 11.3 days
  // (Dubai Airports) — so the window is set wider than that on purpose.
  it('collapses rows spanning close to the real production worst case (11 days)', () => {
    const signals = [
      sig({ id: 'a', found_at: daysAgoIso(11) }),
      sig({ id: 'b', found_at: daysAgoIso(0) }),
    ]
    expect(collapseFeedDuplicates(signals)).toHaveLength(1)
  })

  it('does NOT collapse two rows for the same company+type that are genuinely far apart in time', () => {
    const signals = [
      sig({ id: 'old-story', found_at: daysAgoIso(60) }),
      sig({ id: 'new-story', found_at: daysAgoIso(1) }),
    ]
    const result = collapseFeedDuplicates(signals)
    expect(result).toHaveLength(2)
  })

  it('does NOT collapse rows for the same company but a DIFFERENT signal type', () => {
    const signals = [
      sig({ id: 'expansion-row', signal_type: 'expansion', found_at: daysAgoIso(1) }),
      sig({ id: 'leadership-row', signal_type: 'leadership_change', found_at: daysAgoIso(1) }),
    ]
    const result = collapseFeedDuplicates(signals)
    expect(result).toHaveLength(2)
  })

  it('does NOT collapse rows for a DIFFERENT company, even same type and same day', () => {
    const signals = [
      sig({ id: 'a', company_name: 'DIFC', found_at: daysAgoIso(1) }),
      sig({ id: 'b', company_name: 'Fasset', found_at: daysAgoIso(1) }),
    ]
    const result = collapseFeedDuplicates(signals)
    expect(result).toHaveLength(2)
  })

  it('matches company names fuzzily the same way the rest of the app does (legal suffix differences)', () => {
    const signals = [
      sig({ id: 'a', company_name: 'Acme Trading', found_at: daysAgoIso(1) }),
      sig({ id: 'b', company_name: 'Acme Trading FZE', found_at: daysAgoIso(2) }),
    ]
    expect(collapseFeedDuplicates(signals)).toHaveLength(1)
  })

  // 2026-09-02: collapsing must never hide that there's something genuinely
  // unread just because the row that happened to be most recent was already
  // seen — this is the real regression this test guards against.
  it('prefers an unread ("new") row as the cluster representative even when it is not the most recent one', () => {
    const signals = [
      sig({ id: 'seen-newer', status: 'seen', found_at: daysAgoIso(1) }),
      sig({ id: 'unread-older', status: 'new', found_at: daysAgoIso(3) }),
    ]
    const result = collapseFeedDuplicates(signals)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('unread-older')
  })

  it('chains a rolling cluster: A-B close together, B-C close together, even if A-C alone would exceed the window', () => {
    const signals = [
      sig({ id: 'a', found_at: daysAgoIso(20) }),
      sig({ id: 'b', found_at: daysAgoIso(12) }),
      sig({ id: 'c', found_at: daysAgoIso(4) }),
    ]
    // a-b is 8 days apart, b-c is 8 days apart — both within the window —
    // but a-c is 16 days apart, which alone would be over it. Rolling
    // clustering should still merge all three into one chained cluster.
    expect(collapseFeedDuplicates(signals)).toHaveLength(1)
  })

  it('passes a row through unconditionally when it is missing company_name, signal_type, or found_at', () => {
    const signals = [
      { id: 'no-company', signal_type: 'expansion', found_at: daysAgoIso(1) },
      { id: 'no-type', company_name: 'DIFC', found_at: daysAgoIso(1) },
      { id: 'no-date', company_name: 'DIFC', signal_type: 'expansion' },
    ]
    expect(collapseFeedDuplicates(signals)).toHaveLength(3)
  })

  it('handles an empty/missing list', () => {
    expect(collapseFeedDuplicates([])).toEqual([])
    expect(collapseFeedDuplicates(null)).toEqual([])
  })

  it('returns entries sorted newest-first overall, not grouped', () => {
    const signals = [
      sig({ id: 'company-a', company_name: 'Acme', found_at: daysAgoIso(30) }),
      sig({ id: 'company-b', company_name: 'Globex', found_at: daysAgoIso(1) }),
    ]
    const result = collapseFeedDuplicates(signals)
    expect(result.map(s => s.id)).toEqual(['company-b', 'company-a'])
  })

  it('exports a window constant of 14 days', () => {
    expect(DEDUP_WINDOW_DAYS).toBe(14)
  })
})
