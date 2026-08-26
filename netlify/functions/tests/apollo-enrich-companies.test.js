import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockGetAuthedUser } = vi.hoisted(() => ({ mockGetAuthedUser: vi.fn() }))
const { mockReportServerError } = vi.hoisted(() => ({ mockReportServerError: vi.fn() }))
const { mockSelectIn, mockUpsert, mockRpc, mockCreateClient } = vi.hoisted(() => {
  const mockSelectIn = vi.fn()
  const mockUpsert = vi.fn()
  const mockRpc = vi.fn()
  // 2026-08-26: this endpoint now resolves the caller's tier via
  // getEntitlements (for the per-customer Apollo cap — see
  // resolveResourceCaps in entitlements.js) before doing its own
  // company_enrichment work, so `from` needs to answer BOTH shapes now:
  // the real table this file queries (company_enrichment, select().in())
  // and entitlements.js's own team_members/subscriptions lookup
  // (select().eq().eq().maybeSingle() / select().eq().maybeSingle()).
  // Defaulting the entitlements chain to "no team membership found" (same
  // as entitlements.test.js's own default) resolves every test in this
  // file to Starter tier, which is fine — none of them care about tier-
  // specific caps, only about whether the Apollo call itself did or didn't
  // fire.
  const mockCreateClient = vi.fn(() => ({
    from: vi.fn((table) => {
      if (table === 'team_members' || table === 'subscriptions') {
        const eq = () => ({ eq, maybeSingle: () => Promise.resolve({ data: null, error: null }) })
        return { select: () => ({ eq, maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }
      }
      return {
        select: vi.fn(() => ({ in: mockSelectIn })),
        upsert: mockUpsert,
      }
    }),
    rpc: mockRpc,
  }))
  return { mockSelectIn, mockUpsert, mockRpc, mockCreateClient }
})

vi.mock('../lib/auth.js', () => ({ getAuthedUser: mockGetAuthedUser }))
vi.mock('../lib/reportError.js', () => ({ reportServerError: mockReportServerError }))
vi.mock('@supabase/supabase-js', () => ({ createClient: mockCreateClient }))

function makeRequest(body, { method = 'POST' } = {}) {
  return new Request('https://annie.example/.netlify/functions/apollo-enrich-companies', {
    method,
    body: method === 'GET' ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  })
}

let handler
const originalFetch = global.fetch

beforeEach(async () => {
  vi.clearAllMocks()
  process.env.APOLLO_API_KEY = 'apollo_key_x'
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co'
  process.env.VITE_SUPABASE_ANON_KEY = 'anon_x'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service_role_x'

  mockGetAuthedUser.mockResolvedValue({ user: { id: 'user_123' }, error: null })
  mockSelectIn.mockResolvedValue({ data: [] })
  mockUpsert.mockResolvedValue({ error: null })
  mockRpc.mockResolvedValue({ data: true, error: null })
  global.fetch = vi.fn()

  vi.resetModules()
  ;({ default: handler } = await import('../apollo-enrich-companies.js'))
})

afterEach(() => {
  global.fetch = originalFetch
})

describe('method and configuration guards', () => {
  it('rejects non-POST methods', async () => {
    const res = await handler(makeRequest(null, { method: 'GET' }))
    expect(res.status).toBe(405)
  })

  it('degrades gracefully to an empty, unconfigured result when Apollo is not set up', async () => {
    delete process.env.APOLLO_API_KEY
    const res = await handler(makeRequest({ companies: ['Acme'] }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ results: [], configured: false })
    expect(mockGetAuthedUser).not.toHaveBeenCalled()
  })
})

describe('authentication', () => {
  it('returns 401 for an unauthenticated caller, spending no Apollo credit', async () => {
    mockGetAuthedUser.mockResolvedValue({ user: null, error: 'invalid_session' })
    const res = await handler(makeRequest({ companies: ['Acme'] }))
    expect(res.status).toBe(401)
    expect(global.fetch).not.toHaveBeenCalled()
  })
})

describe('request validation', () => {
  it('returns an empty, configured result when the company list is empty', async () => {
    const res = await handler(makeRequest({ companies: [] }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ results: [], configured: true })
  })

  it('returns 400 when the batch exceeds the 1000-company cap', async () => {
    const companies = Array.from({ length: 1001 }, (_, i) => `Company ${i}`)
    const res = await handler(makeRequest({ companies }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/max 1000/)
  })
})

describe('cache handling', () => {
  it('returns a cached result without spending an Apollo call', async () => {
    mockSelectIn.mockResolvedValue({
      data: [{ company_name_key: 'acme', company_name: 'Acme', industry: 'Staffing', matched: true }],
    })
    const res = await handler(makeRequest({ companies: ['Acme'] }))
    expect(res.status).toBe(200)
    expect(global.fetch).not.toHaveBeenCalled()
    expect(mockUpsert).not.toHaveBeenCalled()
    const body = await res.json()
    expect(body.results).toEqual([
      expect.objectContaining({ company_name_key: 'acme', industry: 'Staffing', matched: true }),
    ])
  })

  it('calls Apollo for a cache miss and writes the result back to the cache', async () => {
    mockSelectIn.mockResolvedValue({ data: [] })
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ organizations: [{ primary_domain: 'acme.com', industry: 'Staffing', city: 'London' }] }),
    })
    const res = await handler(makeRequest({ companies: ['Acme'] }))
    expect(res.status).toBe(200)
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ company_name_key: 'acme', matched: true, domain: 'acme.com' })]),
      expect.objectContaining({ onConflict: 'company_name_key' })
    )
    const body = await res.json()
    expect(body.results[0]).toEqual(expect.objectContaining({ matched: true, domain: 'acme.com' }))
  })

  it('skips the Apollo call and the cache write when the daily credit cap is already reached', async () => {
    mockSelectIn.mockResolvedValue({ data: [] })
    mockRpc.mockResolvedValue({ data: 'platform_cap', error: null })
    const res = await handler(makeRequest({ companies: ['Acme'] }))
    expect(res.status).toBe(200)
    expect(global.fetch).not.toHaveBeenCalled()
    expect(mockUpsert).not.toHaveBeenCalled()
    const body = await res.json()
    expect(body.results[0]).toEqual(expect.objectContaining({ company_name_key: 'acme', matched: false }))
  })
})

describe('error handling', () => {
  it('reports the error and still returns 200 (never a hard failure) when something throws', async () => {
    const res = await handler(makeRequest('not json'))
    expect(res.status).toBe(200)
    expect(mockReportServerError).toHaveBeenCalled()
    const body = await res.json()
    expect(body.results).toEqual([])
  })
})
