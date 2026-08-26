import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { rpcMock, getSessionMock } = vi.hoisted(() => ({ rpcMock: vi.fn(), getSessionMock: vi.fn() }))
vi.mock('../supabase', () => ({ supabase: { rpc: rpcMock, auth: { getSession: getSessionMock } } }))

import {
  summarizeAccounts,
  getAdminAccountSummary,
  getAdminFunnel,
  getAdminSignupTrend,
  getAdminTeamSeats,
  getAdminDataQuality,
  getAdminErrorHealth,
  getAdminOpex,
  getAdminResourceCaps,
  loadAdminOverview,
} from './adminDashboard.js'

const originalFetch = global.fetch

beforeEach(() => {
  vi.clearAllMocks()
  getSessionMock.mockResolvedValue({ data: { session: { access_token: 'tok_admin' } } })
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ apollo: 1200, theirStack: 500, anthropicTokens: 4_000_000 }),
  })
})

afterEach(() => {
  global.fetch = originalFetch
})

describe('summarizeAccounts', () => {
  it('returns zeroed totals for no accounts', () => {
    const result = summarizeAccounts([])
    expect(result).toEqual({
      mrr: 0,
      activeAccounts: 0,
      seatsLive: 0,
      canceledLast30d: 0,
      tierCounts: { starter: 0, growth: 0, team: 0 },
      tierMrr: { starter: 0, growth: 0, team: 0 },
      atRisk: [],
    })
  })

  it('counts an active starter account into MRR, active count, and tier breakdown', () => {
    const result = summarizeAccounts([{ tier: 'starter', status: 'active', billing_interval: 'month', seats: 1 }])
    expect(result.mrr).toBe(79)
    expect(result.activeAccounts).toBe(1)
    expect(result.seatsLive).toBe(1)
    expect(result.tierCounts.starter).toBe(1)
    expect(result.tierMrr.starter).toBe(79)
  })

  it('multiplies a Team subscription by its seat count, on the yearly rate', () => {
    const result = summarizeAccounts([{ tier: 'team', status: 'active', billing_interval: 'year', seats: 4 }])
    expect(result.mrr).toBe(84 * 4)
    expect(result.seatsLive).toBe(4)
    expect(result.tierCounts.team).toBe(1)
    expect(result.tierMrr.team).toBe(84 * 4)
  })

  // 2026-08-26 audit fix: tierMrr used to not exist at all — AdminOverview.jsx
  // approximated it client-side as tierCounts * t.monthly, which was wrong
  // for any annual-billing or per-seat (Team) account. This pins that the
  // per-tier sum is real, billing_interval- and seat-aware revenue, and that
  // it excludes non-live accounts the same way the overall mrr total does.
  it('sums real per-row revenue into tierMrr, distinct per tier, on top of the aggregate mrr', () => {
    const result = summarizeAccounts([
      { tier: 'starter', status: 'active', billing_interval: 'year', seats: 1 }, // 69/mo, discounted
      { tier: 'starter', status: 'active', billing_interval: 'month', seats: 1 }, // 79/mo
      { tier: 'growth', status: 'active', billing_interval: 'month', seats: 1 }, // 129/mo
      { tier: 'team', status: 'past_due', billing_interval: 'month', seats: 5 }, // not live — excluded
    ])
    expect(result.tierMrr.starter).toBe(69 + 79)
    expect(result.tierMrr.growth).toBe(129)
    expect(result.tierMrr.team).toBe(0)
    expect(result.mrr).toBe(69 + 79 + 129)
  })

  it('treats trialing the same as active for the live count, but not for MRR purposes beyond the normal price lookup', () => {
    const result = summarizeAccounts([{ tier: 'growth', status: 'trialing', billing_interval: 'month', seats: 1 }])
    expect(result.activeAccounts).toBe(1)
    expect(result.mrr).toBe(129)
  })

  it('excludes a past_due account from active/MRR and flags it at-risk instead', () => {
    const result = summarizeAccounts([{ tier: 'growth', status: 'past_due', billing_interval: 'month', seats: 1 }])
    expect(result.activeAccounts).toBe(0)
    expect(result.mrr).toBe(0)
    expect(result.atRisk).toHaveLength(1)
    expect(result.atRisk[0].reason).toBe('Payment past due')
  })

  it('flags unpaid separately from past_due', () => {
    const result = summarizeAccounts([{ tier: 'growth', status: 'unpaid', billing_interval: 'month', seats: 1 }])
    expect(result.atRisk[0].reason).toBe('Payment method failed (unpaid)')
  })

  it('flags a live account set to cancel at period end, while still counting it as active revenue today', () => {
    const result = summarizeAccounts([{ tier: 'starter', status: 'active', billing_interval: 'month', seats: 1, cancel_at_period_end: true }])
    expect(result.activeAccounts).toBe(1)
    expect(result.mrr).toBe(79)
    expect(result.atRisk).toHaveLength(1)
    expect(result.atRisk[0].reason).toBe('Set to cancel at period end')
  })

  it('does not double-count: an active, non-cancelling account is not at risk', () => {
    const result = summarizeAccounts([{ tier: 'starter', status: 'active', billing_interval: 'month', seats: 1, cancel_at_period_end: false }])
    expect(result.atRisk).toHaveLength(0)
  })

  it('excludes a canceled subscription from active/MRR/at-risk (it already churned, it is not "at risk" of churning)', () => {
    const result = summarizeAccounts([{ tier: 'starter', status: 'canceled', billing_interval: 'month', seats: 1, subscription_updated_at: new Date().toISOString() }])
    expect(result.activeAccounts).toBe(0)
    expect(result.mrr).toBe(0)
    expect(result.atRisk).toHaveLength(0)
  })

  it('counts a canceled subscription toward canceledLast30d only when its status changed recently', () => {
    const recent = summarizeAccounts([{ tier: 'starter', status: 'canceled', subscription_updated_at: new Date().toISOString() }])
    expect(recent.canceledLast30d).toBe(1)

    const old = summarizeAccounts([{ tier: 'starter', status: 'canceled', subscription_updated_at: '2020-01-01T00:00:00Z' }])
    expect(old.canceledLast30d).toBe(0)
  })

  it('uses subscription_updated_at, not subscription_created_at, to judge recency of cancellation', () => {
    // Created long ago, but the status only flipped to canceled recently —
    // this must still count, because created_at tells us nothing about
    // when the cancellation itself happened.
    const result = summarizeAccounts([{
      tier: 'starter',
      status: 'canceled',
      subscription_created_at: '2020-01-01T00:00:00Z',
      subscription_updated_at: new Date().toISOString(),
    }])
    expect(result.canceledLast30d).toBe(1)
  })
})

describe('RPC wrappers', () => {
  it('getAdminAccountSummary calls get_admin_account_summary and summarizes the rows', async () => {
    rpcMock.mockResolvedValue({ data: [{ tier: 'starter', status: 'active', billing_interval: 'month', seats: 1 }], error: null })
    const result = await getAdminAccountSummary()
    expect(rpcMock).toHaveBeenCalledWith('get_admin_account_summary')
    expect(result.activeAccounts).toBe(1)
  })

  it('getAdminAccountSummary throws on an RPC error rather than returning a half-true summary', async () => {
    rpcMock.mockResolvedValue({ data: null, error: new Error('not authorized') })
    await expect(getAdminAccountSummary()).rejects.toThrow('not authorized')
  })

  it('getAdminFunnel calls get_admin_funnel and returns the single row', async () => {
    rpcMock.mockResolvedValue({ data: [{ total_signups: 3 }], error: null })
    const result = await getAdminFunnel()
    expect(rpcMock).toHaveBeenCalledWith('get_admin_funnel')
    expect(result.total_signups).toBe(3)
  })

  it('getAdminFunnel returns null when nothing comes back', async () => {
    rpcMock.mockResolvedValue({ data: [], error: null })
    expect(await getAdminFunnel()).toBeNull()
  })

  it('getAdminSignupTrend passes the requested day count through', async () => {
    rpcMock.mockResolvedValue({ data: [{ day: '2026-08-01', signups: 1 }], error: null })
    await getAdminSignupTrend(7)
    expect(rpcMock).toHaveBeenCalledWith('get_admin_signup_trend', { p_days: 7 })
  })

  it('getAdminTeamSeats returns the raw rows', async () => {
    rpcMock.mockResolvedValue({ data: [{ team_id: 't1', total_members: 4, active_members: 2 }], error: null })
    const result = await getAdminTeamSeats()
    expect(result).toHaveLength(1)
  })

  it('getAdminDataQuality returns the single row, or null when empty', async () => {
    rpcMock.mockResolvedValue({ data: [], error: null })
    expect(await getAdminDataQuality()).toBeNull()
  })

  it('getAdminErrorHealth defaults to zeros rather than null when nothing comes back', async () => {
    rpcMock.mockResolvedValue({ data: [], error: null })
    expect(await getAdminErrorHealth()).toEqual({ last_24h: 0, prior_24h: 0 })
  })

  it('getAdminOpex passes the requested day count through', async () => {
    rpcMock.mockResolvedValue({ data: [], error: null })
    await getAdminOpex(14)
    expect(rpcMock).toHaveBeenCalledWith('get_admin_opex', { p_days: 14 })
  })

  it('getAdminResourceCaps calls the admin-resource-caps endpoint with the caller\'s own session token', async () => {
    const result = await getAdminResourceCaps()
    expect(global.fetch).toHaveBeenCalledWith('/.netlify/functions/admin-resource-caps', {
      headers: { Authorization: 'Bearer tok_admin' },
    })
    expect(result).toEqual({ apollo: 1200, theirStack: 500, anthropicTokens: 4_000_000 })
  })

  it('getAdminResourceCaps throws when there is no session to authenticate with', async () => {
    getSessionMock.mockResolvedValue({ data: { session: null } })
    await expect(getAdminResourceCaps()).rejects.toThrow('session has expired')
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('getAdminResourceCaps throws the server\'s own error message on a non-admin caller', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'Not authorized' }) })
    await expect(getAdminResourceCaps()).rejects.toThrow('Not authorized')
  })
})

describe('loadAdminOverview', () => {
  it('fetches all eight pieces together and shapes them under named keys', async () => {
    rpcMock.mockResolvedValue({ data: [], error: null })
    const result = await loadAdminOverview()
    expect(rpcMock).toHaveBeenCalledTimes(7)
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(Object.keys(result).sort()).toEqual(['accounts', 'dataQuality', 'errorHealth', 'funnel', 'opex', 'resourceCaps', 'signupTrend', 'teamSeats'].sort())
  })

  it('rejects the whole load if any single RPC fails, rather than rendering a partly-true dashboard', async () => {
    rpcMock.mockImplementation((name) => {
      if (name === 'get_admin_error_health') return Promise.resolve({ data: null, error: new Error('boom') })
      return Promise.resolve({ data: [], error: null })
    })
    await expect(loadAdminOverview()).rejects.toThrow('boom')
  })

  it('rejects the whole load if the resource-caps fetch fails too, same "fail loud" rule', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'Not authorized' }) })
    rpcMock.mockResolvedValue({ data: [], error: null })
    await expect(loadAdminOverview()).rejects.toThrow('Not authorized')
  })
})
