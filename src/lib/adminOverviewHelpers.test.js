import { describe, it, expect } from 'vitest'
import {
  trendDelta,
  groupErrorsBySource,
  daysSince,
  initials,
  timeAgo,
  bucketAtRiskReasons,
  countEscalationsFromChurnedAccounts,
  countChurnedWithinDays,
  filterAccountRows,
  estimateVendorSpend,
  THEIRSTACK_COST_PER_CREDIT,
  APOLLO_COST_PER_CREDIT,
  ANTHROPIC_BLENDED_COST_PER_MILLION_TOKENS,
} from './adminOverviewHelpers.js'

describe('trendDelta', () => {
  it('returns null with fewer than 2 rows', () => {
    expect(trendDelta([], 'mrr')).toBeNull()
    expect(trendDelta([{ day: '2026-09-01', mrr: 100 }], 'mrr')).toBeNull()
  })

  it('compares the latest row against the closest row at least `daysAgo` back', () => {
    const rows = [
      { day: '2026-08-01', mrr: 1000 },
      { day: '2026-08-15', mrr: 1500 },
      { day: '2026-09-01', mrr: 2000 },
    ]
    const result = trendDelta(rows, 'mrr', 30)
    expect(result.from).toBe(1000)
    expect(result.to).toBe(2000)
    expect(result.diff).toBe(1000)
    expect(result.pct).toBe(100)
  })

  it('returns null when the comparison point IS the latest row (not enough real history yet)', () => {
    const rows = [{ day: '2026-09-01', mrr: 500 }, { day: '2026-09-02', mrr: 600 }]
    // both rows are within the last 30 days of "today" (2026-09-02), so the
    // loop's comparison never moves past the first row — but the first row
    // is not the latest row, so this actually returns a real delta. Cover
    // the genuine "only one snapshot ever, requested window is huge" case
    // instead, where comparison degenerates to the latest row itself.
    const singleDayApart = [{ day: '2026-09-02', mrr: 700 }]
    expect(trendDelta(singleDayApart, 'mrr', 30)).toBeNull()
    expect(trendDelta(rows, 'mrr', 30)).not.toBeNull()
  })

  it('handles a zero starting value without dividing by zero (pct is null, diff is real)', () => {
    const rows = [{ day: '2026-08-01', mrr: 0 }, { day: '2026-09-01', mrr: 200 }]
    const result = trendDelta(rows, 'mrr', 30)
    expect(result.diff).toBe(200)
    expect(result.pct).toBeNull()
  })

  it('skips a non-finite value rather than returning a broken delta', () => {
    const rows = [{ day: '2026-08-01', mrr: undefined }, { day: '2026-09-01', mrr: 200 }]
    expect(trendDelta(rows, 'mrr', 30)).toBeNull()
  })

  it('treats a null value as 0, not as missing (Number(null) is 0, a real finite number)', () => {
    const rows = [{ day: '2026-08-01', mrr: null }, { day: '2026-09-01', mrr: 200 }]
    const result = trendDelta(rows, 'mrr', 30)
    expect(result).toEqual({ from: 0, to: 200, diff: 200, pct: null })
  })
})

describe('groupErrorsBySource', () => {
  const now = new Date('2026-09-02T12:00:00Z').getTime()

  it('groups function errors by fn_name and client errors under "client"', () => {
    const logs = [
      { source: 'function', fn_name: 'chat.js', created_at: new Date(now - 60_000).toISOString() },
      { source: 'function', fn_name: 'chat.js', created_at: new Date(now - 60_000).toISOString() },
      { source: 'client', created_at: new Date(now - 60_000).toISOString() },
    ]
    const result = groupErrorsBySource(logs, now)
    expect(result).toEqual([['chat.js', 2], ['client', 1]])
  })

  it('excludes errors older than 24h', () => {
    const logs = [
      { source: 'function', fn_name: 'old.js', created_at: new Date(now - 25 * 60 * 60 * 1000).toISOString() },
      { source: 'function', fn_name: 'recent.js', created_at: new Date(now - 60_000).toISOString() },
    ]
    expect(groupErrorsBySource(logs, now)).toEqual([['recent.js', 1]])
  })

  it('falls back to "function" when fn_name is missing', () => {
    const logs = [{ source: 'function', created_at: new Date(now - 60_000).toISOString() }]
    expect(groupErrorsBySource(logs, now)).toEqual([['function', 1]])
  })

  it('sorts by count descending', () => {
    const logs = [
      { source: 'function', fn_name: 'a.js', created_at: new Date(now - 1000).toISOString() },
      { source: 'function', fn_name: 'b.js', created_at: new Date(now - 1000).toISOString() },
      { source: 'function', fn_name: 'b.js', created_at: new Date(now - 1000).toISOString() },
    ]
    expect(groupErrorsBySource(logs, now)).toEqual([['b.js', 2], ['a.js', 1]])
  })

  it('returns an empty array for no logs', () => {
    expect(groupErrorsBySource([], now)).toEqual([])
  })
})

describe('daysSince', () => {
  it('returns null for a missing timestamp', () => {
    expect(daysSince(null)).toBeNull()
  })

  it('returns whole days elapsed', () => {
    const now = new Date('2026-09-02T00:00:00Z').getTime()
    expect(daysSince(new Date('2026-08-20T00:00:00Z').toISOString(), now)).toBe(13)
  })
})

describe('initials', () => {
  it('returns em-dash for a missing name', () => {
    expect(initials(null)).toBe('—')
    expect(initials('')).toBe('—')
  })

  it('takes the first letter of the first two words, uppercased', () => {
    expect(initials('Vantage Search Group')).toBe('VS')
    expect(initials('acme')).toBe('A')
  })
})

describe('timeAgo', () => {
  const now = new Date('2026-09-02T12:00:00Z').getTime()

  it('says "just now" for under an hour', () => {
    expect(timeAgo(new Date(now - 5 * 60 * 1000).toISOString(), now)).toBe('just now')
  })

  it('says hours for under a day', () => {
    expect(timeAgo(new Date(now - 5 * 60 * 60 * 1000).toISOString(), now)).toBe('5 hours ago')
  })

  it('says days for a day or more, singular at 1', () => {
    expect(timeAgo(new Date(now - 48 * 60 * 60 * 1000).toISOString(), now)).toBe('2 days ago')
    expect(timeAgo(new Date(now - 24 * 60 * 60 * 1000).toISOString(), now)).toBe('1 day ago')
  })
})

describe('bucketAtRiskReasons', () => {
  it('splits billing-failed reasons from cancel-at-period-end reasons', () => {
    const atRisk = [
      { reason: 'Payment past due' },
      { reason: 'Payment method failed (unpaid)' },
      { reason: 'Set to cancel at period end' },
    ]
    expect(bucketAtRiskReasons(atRisk)).toEqual({ billingFailed: 2, settingToCancel: 1 })
  })

  it('handles an empty list', () => {
    expect(bucketAtRiskReasons([])).toEqual({ billingFailed: 0, settingToCancel: 0 })
  })
})

describe('countEscalationsFromChurnedAccounts', () => {
  it('counts only escalations whose user_id belongs to a canceled account', () => {
    const escalations = [{ user_id: 'u1' }, { user_id: 'u2' }, { user_id: 'u3' }]
    const accountRows = [{ user_id: 'u1', status: 'canceled' }, { user_id: 'u2', status: 'active' }]
    expect(countEscalationsFromChurnedAccounts(escalations, accountRows)).toBe(1)
  })

  it('returns 0 when nothing matches', () => {
    expect(countEscalationsFromChurnedAccounts([{ user_id: 'u1' }], [{ user_id: 'u1', status: 'active' }])).toBe(0)
  })
})

describe('countChurnedWithinDays', () => {
  it('counts canceled rows whose subscription_updated_at falls inside the window', () => {
    const now = Date.now()
    const rows = [
      { status: 'canceled', subscription_updated_at: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString() },
      { status: 'canceled', subscription_updated_at: new Date(now - 200 * 24 * 60 * 60 * 1000).toISOString() },
      { status: 'active', subscription_updated_at: new Date(now).toISOString() },
    ]
    expect(countChurnedWithinDays(rows, 90)).toBe(1)
  })
})

describe('estimateVendorSpend', () => {
  it('converts TheirStack credits to real dollars at the confirmed $12/1,000 rate, marked confirmed', () => {
    const result = estimateVendorSpend({ theirstackCredits: 1000 })
    expect(result.theirstack).toEqual({ amount: 1000 * THEIRSTACK_COST_PER_CREDIT, confidence: 'confirmed' })
    expect(result.theirstack.amount).toBeCloseTo(12, 5)
  })

  it('converts Apollo credits to dollars at the published-list rate, marked estimated (not confirmed)', () => {
    const result = estimateVendorSpend({ apolloCredits: 2000 })
    expect(result.apollo).toEqual({ amount: 2000 * APOLLO_COST_PER_CREDIT, confidence: 'estimated' })
    expect(result.apollo.amount).toBeCloseTo(99, 5) // 2,000 credits ≈ Apollo's own Professional-plan allotment at $99/mo
  })

  it('converts Anthropic tokens to dollars using the blended input/output rate, marked estimated', () => {
    const result = estimateVendorSpend({ anthropicTokens: 2_000_000 })
    expect(result.anthropic).toEqual({ amount: 2 * ANTHROPIC_BLENDED_COST_PER_MILLION_TOKENS, confidence: 'estimated' })
  })

  it('defaults every usage figure to 0 rather than throwing when called with no data yet', () => {
    expect(estimateVendorSpend()).toEqual({
      apollo: { amount: 0, confidence: 'estimated' },
      theirstack: { amount: 0, confidence: 'confirmed' },
      anthropic: { amount: 0, confidence: 'estimated' },
    })
  })

  it('the blended Anthropic rate sits between the published input-only and output-only rates', () => {
    expect(ANTHROPIC_BLENDED_COST_PER_MILLION_TOKENS).toBeGreaterThan(1)
    expect(ANTHROPIC_BLENDED_COST_PER_MILLION_TOKENS).toBeLessThan(5)
  })
})

describe('filterAccountRows', () => {
  const rows = [
    { firm_name: 'Vantage Search Group', email: 'mstubbs@meetannie.ai' },
    { firm_name: 'Redline Executive', email: 'priya@redline.example' },
  ]

  it('returns everything when the query is blank', () => {
    expect(filterAccountRows(rows, '')).toEqual(rows)
    expect(filterAccountRows(rows, '   ')).toEqual(rows)
  })

  it('matches firm name case-insensitively', () => {
    expect(filterAccountRows(rows, 'vantage')).toEqual([rows[0]])
  })

  it('matches email case-insensitively', () => {
    expect(filterAccountRows(rows, 'REDLINE.EXAMPLE')).toEqual([rows[1]])
  })

  it('returns an empty array when nothing matches', () => {
    expect(filterAccountRows(rows, 'nonexistent')).toEqual([])
  })
})
