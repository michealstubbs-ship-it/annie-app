// admin-daily-metrics-snapshot.js writes one row/day so the Annie Overview
// trend charts have real history — these tests cover: MRR is computed
// correctly across flat-rate and per-seat tiers using the real
// src/lib/pricing.js prices (not a duplicated/hardcoded copy), an
// unrecognized tier never throws off the whole total, contact-verified/
// company-matched rates are computed correctly (including the zero-total
// case, which must not divide by zero), the upsert lands on today's date
// with onConflict: 'day' (so a retry never creates duplicate history), and
// a failure anywhere is reported but still returns 200 (same "never let a
// background job's own failure alarm anyone but Michael" posture as every
// other scheduled function in this codebase).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TIERS } from '../../../src/lib/pricing.js'

const { mockReportServerError } = vi.hoisted(() => ({ mockReportServerError: vi.fn().mockResolvedValue(undefined) }))
const { mockUpsert } = vi.hoisted(() => ({ mockUpsert: vi.fn().mockResolvedValue({ error: null }) }))
const { state } = vi.hoisted(() => ({
  state: {
    subs: [],
    subsError: null,
    signalsTotal: 0, signalsVerified: 0, companiesTotal: 0, companiesMatched: 0,
    countErrors: {},
  },
}))

const { mockCreateClient } = vi.hoisted(() => {
  // A real supabase-js query builder is itself PromiseLike — `await
  // supabase.from(t).select(..., {count, head:true})` resolves directly,
  // no further method call needed, while `.eq(...)` chained onto it returns
  // its own awaitable for the filtered count. This mock mirrors both shapes
  // rather than assuming only one is ever awaited.
  function tableCountBuilder(totalResult, filteredResult) {
    return {
      then(resolve, reject) { return Promise.resolve(totalResult).then(resolve, reject) },
      eq() { return Promise.resolve(filteredResult) },
    }
  }
  return {
    mockCreateClient: vi.fn(() => ({
      from(table) {
        if (table === 'subscriptions') {
          return { select: () => ({ in: () => Promise.resolve({ data: state.subs, error: state.subsError }) }) }
        }
        if (table === 'intelligence_signals') {
          return {
            select: () => tableCountBuilder(
              { count: state.signalsTotal, error: state.countErrors.signalsTotal || null },
              { count: state.signalsVerified, error: state.countErrors.signalsVerified || null },
            ),
          }
        }
        if (table === 'company_enrichment') {
          return {
            select: () => tableCountBuilder(
              { count: state.companiesTotal, error: state.countErrors.companiesTotal || null },
              { count: state.companiesMatched, error: state.countErrors.companiesMatched || null },
            ),
          }
        }
        if (table === 'admin_daily_metrics') {
          return { upsert: mockUpsert }
        }
        throw new Error(`unexpected table ${table}`)
      },
    })),
  }
})

vi.mock('@supabase/supabase-js', () => ({ createClient: mockCreateClient }))
vi.mock('../lib/reportError.js', () => ({ reportServerError: mockReportServerError }))

let handler

beforeEach(async () => {
  vi.clearAllMocks()
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service_role_x'
  mockUpsert.mockResolvedValue({ error: null })
  state.subs = []
  state.subsError = null
  state.signalsTotal = 0; state.signalsVerified = 0
  state.companiesTotal = 0; state.companiesMatched = 0
  state.countErrors = {}
  vi.resetModules()
  ;({ default: handler } = await import('../admin-daily-metrics-snapshot.js'))
})

const solo = TIERS.find(t => t.key === 'solo')
const team = TIERS.find(t => t.key === 'team')

it('computes MRR across a flat-rate tier and a per-seat tier using the real pricing.js prices', async () => {
  state.subs = [
    { tier: 'solo', status: 'active', seats: 1 },
    { tier: 'solo', status: 'active', seats: 1 },
    { tier: 'team', status: 'active', seats: 4 },
  ]
  await handler()
  const expectedMrr = solo.monthly + solo.monthly + (team.monthly * 4)
  expect(mockUpsert).toHaveBeenCalledWith(
    expect.objectContaining({ mrr: expectedMrr, active_accounts: 3 }),
    { onConflict: 'day' },
  )
})

it('defaults a per-seat account with no seats value to 1 seat, never NaN/undefined', async () => {
  state.subs = [{ tier: 'team', status: 'active', seats: null }]
  await handler()
  expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({ mrr: team.monthly }), expect.anything())
})

it('skips an unrecognized tier key rather than letting it throw off the whole total or crash', async () => {
  state.subs = [
    { tier: 'solo', status: 'active', seats: 1 },
    { tier: 'legacy-plan-2024', status: 'active', seats: 1 },
  ]
  await handler()
  expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({ mrr: solo.monthly, active_accounts: 2 }), expect.anything())
})

it('computes contact-verified and company-matched rates from real counts', async () => {
  state.signalsTotal = 200; state.signalsVerified = 148
  state.companiesTotal = 90; state.companiesMatched = 73
  await handler()
  expect(mockUpsert).toHaveBeenCalledWith(
    expect.objectContaining({ contact_verified_rate: 148 / 200, company_matched_rate: 73 / 90 }),
    expect.anything(),
  )
})

it('reports a null rate instead of dividing by zero when there are no signals/companies yet', async () => {
  state.signalsTotal = 0; state.companiesTotal = 0
  await handler()
  expect(mockUpsert).toHaveBeenCalledWith(
    expect.objectContaining({ contact_verified_rate: null, company_matched_rate: null }),
    expect.anything(),
  )
})

it('upserts today\'s date with onConflict: "day" so a retry never creates duplicate history', async () => {
  await handler()
  const call = mockUpsert.mock.calls[0]
  const today = new Date().toISOString().slice(0, 10)
  expect(call[0].day).toBe(today)
  expect(call[1]).toEqual({ onConflict: 'day' })
})

it('reports but still returns 200 when the subscriptions read fails', async () => {
  state.subsError = { message: 'db down' }
  const resp = await handler()
  expect(resp.status).toBe(200)
  expect(mockReportServerError).toHaveBeenCalledWith('admin-daily-metrics-snapshot', expect.any(Error), {})
  expect(mockUpsert).not.toHaveBeenCalled()
})

it('reports but still returns 200 when the upsert itself fails', async () => {
  mockUpsert.mockResolvedValue({ error: { message: 'upsert denied' } })
  const resp = await handler()
  expect(resp.status).toBe(200)
  expect(mockReportServerError).toHaveBeenCalled()
})

it('returns 200 without touching Supabase at all when not configured', async () => {
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
  const resp = await handler()
  expect(resp.status).toBe(200)
  expect(mockCreateClient).not.toHaveBeenCalled()
})
