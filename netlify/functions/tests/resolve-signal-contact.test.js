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
  // employee_count/enriched_at (post-cutoff) included so this cached row
  // reads as already backfilled for the mega-employer filter (scanShared.js
  // — enrichCompany's needsEmployeeCountBackfill check) and doesn't trigger
  // an unexpected live re-lookup this test suite isn't set up to answer.
  mockEnrichmentSelect.mockResolvedValue({ data: { domain: 'acme.com', industry: null, city: null, state: null, country: null, logo_url: null, matched: true, apollo_org_id: 'org_1', employee_count: 500, enriched_at: new Date().toISOString() } })
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
    // 2026-09-04: the response now also carries the contact it already had
    // and the customer's credit meter, so a second click renders the same
    // card as the first without another round trip. A cache hit costs
    // nothing and charges nothing.
    const body = await res.json()
    expect(body.found).toBe(true)
    expect(body.alreadyResolved).toBe(true)
    // topupBalance is part of the shape now — purchased credits sit on top of
    // the monthly allowance and do not expire (see topups.js).
    expect(body.credits).toEqual({ used: 0, limit: 50, topupBalance: 0, remaining: 50 })
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

// 2026-09-04. Contacts moved from "enriched for every signal at scan time" to
// "fetched when the recruiter clicks", with a real monthly allowance per plan.
// Two facts verified against the live Apollo API that day shape every
// assertion here: a search costs zero credits, and an enrichment that matches
// nobody costs zero credits. So a failed lookup is free to Annie and must be
// free to the customer.
describe('the monthly contact allowance', () => {
  function withTeam({ used = 0, tier = 'starter', topupBalance = 0 } = {}) {
    mockCreateClient.mockImplementation(() => ({
      from: vi.fn((table) => {
        if (table === 'team_members') {
          return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { team_id: 'team_1' }, error: null }) }) }) }) }
        }
        if (table === 'subscriptions') {
          return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { tier, status: 'active' }, error: null }) }) }) }
        }
        if (table === 'company_enrichment') return { select: () => ({ eq: () => ({ maybeSingle: mockEnrichmentSelect }) }) }
        if (table === 'intelligence_signals') {
          return {
            select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: mockSignalSelect }) }) }),
            update: () => ({ eq: () => ({ eq: mockSignalUpdate }) }),
          }
        }
        throw new Error(`unexpected table ${table}`)
      }),
      rpc: vi.fn(async (name, args) => {
        if (name === 'contact_credits_used') return { data: used, error: null }
        if (name === 'contact_credits_topup_balance') return { data: topupBalance, error: null }
        if (name === 'contact_credits_consume_v2') {
          // Mirrors the real function: monthly allowance first, purchased
          // balance only once it is exhausted.
          const cap = args?.p_monthly_cap ?? 0
          if (used < cap) return { data: [{ source: 'monthly', monthly_used: used + 1, topup_balance: topupBalance }], error: null }
          if (topupBalance > 0) return { data: [{ source: 'topup', monthly_used: used, topup_balance: topupBalance - 1 }], error: null }
          return { data: [{ source: null, monthly_used: used, topup_balance: 0 }], error: null }
        }
        return mockRpc(name, args)
      }),
    }))
  }

  it('refuses BEFORE spending anything at Apollo when the allowance is gone', async () => {
    withTeam({ used: 50, tier: 'starter' })
    mockSignalSelect.mockResolvedValue({ data: BASE_SIGNAL, error: null })
    const fetchSpy = vi.fn()
    global.fetch = fetchSpy

    const res = await handler(makeRequest({ signalId: 'sig_1' }))
    const body = await res.json()

    expect(body.capReached).toBe(true)
    expect(body.found).toBe(false)
    expect(body.credits.remaining).toBe(0)
    // The point of checking first: nothing is spent on a request that was
    // never going to be allowed.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('charges nothing when Apollo genuinely finds nobody', async () => {
    withTeam({ used: 3 })
    mockSignalSelect.mockResolvedValue({ data: BASE_SIGNAL, error: null })
    mockEnrichmentSelect.mockResolvedValue({ data: null, error: null })
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ organizations: [], people: [], person: null }) })

    const res = await handler(makeRequest({ signalId: 'sig_1' }))
    const body = await res.json()

    expect(body.found).toBe(false)
    expect(body.charged).toBe(false)
    // Unchanged — a lookup that returns nothing is free at Apollo and must be
    // free here too.
    expect(body.credits.used).toBe(3)
  })

  it('gives Growth a larger allowance than Starter', async () => {
    withTeam({ used: 0, tier: 'growth' })
    mockSignalSelect.mockResolvedValue({ data: { ...BASE_SIGNAL, contact_verified: true, contact_name: 'Dana Riaz' }, error: null })
    const res = await handler(makeRequest({ signalId: 'sig_1' }))
    const body = await res.json()
    expect(body.credits.limit).toBe(150)
  })
})
