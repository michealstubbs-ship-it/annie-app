import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockGetAuthedUser } = vi.hoisted(() => ({ mockGetAuthedUser: vi.fn() }))
const { mockReportServerError } = vi.hoisted(() => ({ mockReportServerError: vi.fn() }))
const { mockSignalSelect, mockSignalUpdate, mockEnrichmentSelect, mockRpc, mockCreateClient } = vi.hoisted(() => {
  const mockSignalSelect = vi.fn()
  const mockSignalUpdate = vi.fn()
  const mockEnrichmentSelect = vi.fn()
  const mockRpc = vi.fn()
  // Same table-aware shape as apollo-enrich-companies.test.js's mock: this
  // endpoint touches intelligence_signals (the signal being resolved),
  // company_enrichment (enrichCompany's own cache, keyed by company name),
  // and team_members/subscriptions (getEntitlements, for the tier-scoped
  // Apollo cap) — three real tables, one mock, dispatched by name.
  const mockCreateClient = vi.fn(() => ({
    from: vi.fn((table) => {
      if (table === 'team_members' || table === 'subscriptions') {
        const eq = () => ({ eq, maybeSingle: () => Promise.resolve({ data: null, error: null }) })
        return { select: () => ({ eq, maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }
      }
      if (table === 'company_enrichment') {
        return { select: () => ({ eq: () => ({ maybeSingle: mockEnrichmentSelect }) }) }
      }
      if (table === 'intelligence_signals') {
        return {
          select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: mockSignalSelect }) }) }),
          update: () => ({ eq: () => ({ eq: mockSignalUpdate }) }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    }),
    rpc: mockRpc,
  }))
  return { mockSignalSelect, mockSignalUpdate, mockEnrichmentSelect, mockRpc, mockCreateClient }
})

vi.mock('../lib/auth.js', () => ({ getAuthedUser: mockGetAuthedUser }))
vi.mock('../lib/reportError.js', () => ({ reportServerError: mockReportServerError }))
vi.mock('@supabase/supabase-js', () => ({ createClient: mockCreateClient }))

function makeRequest(body, { method = 'POST' } = {}) {
  return new Request('https://annie.example/.netlify/functions/resolve-signal-contact', {
    method,
    body: method === 'GET' ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  })
}

const BASE_SIGNAL = { id: 'sig_1', user_id: 'user_123', company_name: 'Acme Ltd', signal_type: 'leadership_change', title_keywords: ['Chief Financial Officer'], contact_verified: false, contact_candidates: null }

let handler
const originalFetch = global.fetch

beforeEach(async () => {
  vi.clearAllMocks()
  process.env.APOLLO_API_KEY = 'apollo_key_x'
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co'
  process.env.VITE_SUPABASE_ANON_KEY = 'anon_x'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service_role_x'

  mockGetAuthedUser.mockResolvedValue({ user: { id: 'user_123' }, error: null })
  mockSignalSelect.mockResolvedValue({ data: BASE_SIGNAL, error: null })
  mockSignalUpdate.mockResolvedValue({ error: null })
  mockEnrichmentSelect.mockResolvedValue({ data: { domain: 'acme.com', industry: null, city: null, state: null, country: null, logo_url: null, matched: true, apollo_org_id: 'org_1' } })
  mockRpc.mockResolvedValue({ data: 'ok', error: null })
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ people: [] }) })

  vi.resetModules()
  ;({ default: handler } = await import('../resolve-signal-contact.js'))
})

afterEach(() => {
  global.fetch = originalFetch
})

describe('method and configuration guards', () => {
  it('rejects non-POST methods', async () => {
    const res = await handler(makeRequest(null, { method: 'GET' }))
    expect(res.status).toBe(405)
  })

  it('degrades gracefully when Apollo is not configured', async () => {
    delete process.env.APOLLO_API_KEY
    const res = await handler(makeRequest({ signalId: 'sig_1' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ found: false, configured: false })
    expect(mockGetAuthedUser).not.toHaveBeenCalled()
  })
})

describe('authentication and ownership', () => {
  it('returns 401 for an unauthenticated caller, spending no Apollo credit', async () => {
    mockGetAuthedUser.mockResolvedValue({ user: null, error: 'invalid_session' })
    const res = await handler(makeRequest({ signalId: 'sig_1' }))
    expect(res.status).toBe(401)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('returns 400 when signalId is missing', async () => {
    const res = await handler(makeRequest({}))
    expect(res.status).toBe(400)
  })

  // The mock's own eq().eq() chain models the real query's .eq('id',
  // signalId).eq('user_id', user.id) — a signal belonging to someone else
  // (or one that doesn't exist) resolves to no row either way, exactly like
  // the real RLS-backed query would, never leaking whose it actually is.
  it('returns 404 when the signal does not exist or does not belong to this caller', async () => {
    mockSignalSelect.mockResolvedValue({ data: null, error: null })
    const res = await handler(makeRequest({ signalId: 'sig_missing' }))
    expect(res.status).toBe(404)
  })
})

describe('already resolved', () => {
  it('short-circuits without spending any Apollo credit when the signal already has a verified contact', async () => {
    mockSignalSelect.mockResolvedValue({ data: { ...BASE_SIGNAL, contact_verified: true }, error: null })
    const res = await handler(makeRequest({ signalId: 'sig_1' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ found: true, alreadyResolved: true })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('short-circuits the same way when the signal already has a contact_candidates panel', async () => {
    mockSignalSelect.mockResolvedValue({ data: { ...BASE_SIGNAL, contact_candidates: [{ function: 'commercial', name: 'A' }] }, error: null })
    const res = await handler(makeRequest({ signalId: 'sig_1' }))
    expect((await res.json()).alreadyResolved).toBe(true)
    expect(global.fetch).not.toHaveBeenCalled()
  })
})

describe('live re-resolution', () => {
  it('finds a contact via the forced extended-tier fallback and writes it back onto the signal row', async () => {
    // Standard buckets all come back empty; only the extended-tier bucket
    // (operations/general_management) resolves someone — this is exactly
    // the case this endpoint exists for: forcing the wider pass on
    // regardless of the caller's real tier.
    global.fetch = vi.fn(async (url, opts) => {
      if (url.includes('mixed_people/api_search')) {
        const body = JSON.parse(opts.body)
        if (body.person_titles?.includes('Managing Director')) {
          return { ok: true, json: async () => ({ people: [{ first_name: 'Layla', last_name: 'Haddad', title: 'Managing Director', id: 'p1' }] }) }
        }
        return { ok: true, json: async () => ({ people: [] }) }
      }
      if (url.includes('people/match')) return { ok: true, json: async () => ({ person: { first_name: 'Layla', last_name: 'Haddad', email: 'layla@acme.com' } }) }
      return { ok: true, text: async () => '' }
    })
    const res = await handler(makeRequest({ signalId: 'sig_1' }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.found).toBe(true)
    expect(body.contactCandidates.some(c => c.name === 'Layla Haddad')).toBe(true)
    expect(mockSignalUpdate).toHaveBeenCalled()
  })

  it('returns found:false, honestly, when nobody is findable across every layer — never an error', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ people: [] }) })
    const res = await handler(makeRequest({ signalId: 'sig_1' }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.found).toBe(false)
    expect(body.error).toBeUndefined()
    expect(mockSignalUpdate).not.toHaveBeenCalled()
  })
})
