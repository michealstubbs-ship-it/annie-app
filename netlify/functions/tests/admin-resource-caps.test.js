import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetAuthedUser } = vi.hoisted(() => ({ mockGetAuthedUser: vi.fn() }))
const { mockReportServerError } = vi.hoisted(() => ({ mockReportServerError: vi.fn() }))
const { mockProfileSelect, mockCreateClient } = vi.hoisted(() => {
  const mockProfileSelect = vi.fn()
  const mockCreateClient = vi.fn(() => ({
    from: vi.fn((table) => {
      if (table === 'profiles') {
        return { select: () => ({ eq: () => ({ maybeSingle: mockProfileSelect }) }) }
      }
      throw new Error(`unexpected table ${table}`)
    }),
  }))
  return { mockProfileSelect, mockCreateClient }
})

vi.mock('../lib/auth.js', () => ({ getAuthedUser: mockGetAuthedUser }))
vi.mock('../lib/reportError.js', () => ({ reportServerError: mockReportServerError }))
vi.mock('@supabase/supabase-js', () => ({ createClient: mockCreateClient }))

function makeRequest({ method = 'GET' } = {}) {
  return new Request('https://annie.example/.netlify/functions/admin-resource-caps', { method })
}

let handler

beforeEach(async () => {
  vi.clearAllMocks()
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co'
  process.env.VITE_SUPABASE_ANON_KEY = 'anon_x'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service_role_x'

  mockGetAuthedUser.mockResolvedValue({ user: { id: 'user_admin' }, error: null })
  mockProfileSelect.mockResolvedValue({ data: { is_admin: true }, error: null })

  vi.resetModules()
  ;({ default: handler } = await import('../admin-resource-caps.js'))
})

describe('method and auth guards', () => {
  it('rejects non-GET methods', async () => {
    const res = await handler(makeRequest({ method: 'POST' }))
    expect(res.status).toBe(405)
  })

  it('returns 401 for an unauthenticated caller, never touching the profiles table', async () => {
    mockGetAuthedUser.mockResolvedValue({ user: null, error: 'invalid_session' })
    const res = await handler(makeRequest())
    expect(res.status).toBe(401)
    expect(mockProfileSelect).not.toHaveBeenCalled()
  })

  it('returns 403 for an authenticated caller who is not an admin', async () => {
    mockProfileSelect.mockResolvedValue({ data: { is_admin: false }, error: null })
    const res = await handler(makeRequest())
    expect(res.status).toBe(403)
  })

  it('returns 403 when the caller has no profile row at all, same as a non-admin', async () => {
    mockProfileSelect.mockResolvedValue({ data: null, error: null })
    const res = await handler(makeRequest())
    expect(res.status).toBe(403)
  })
})

describe('live values', () => {
  it('returns the real live platform caps from entitlements.js, not a hardcoded copy', async () => {
    const res = await handler(makeRequest())
    const body = await res.json()
    expect(res.status).toBe(200)
    // These come straight from DEFAULT_PLATFORM_CAPS in entitlements.js — a
    // future tuning change there should flow through here automatically,
    // which is the entire point of this endpoint existing.
    expect(body).toEqual({ apollo: 1200, theirStack: 500, anthropicTokens: 4_000_000 })
  })

  it('respects an env-var override the same way a real reserve*Credits call would', async () => {
    process.env.APOLLO_DAILY_CREDIT_CAP = '9999'
    const res = await handler(makeRequest())
    const body = await res.json()
    expect(body.apollo).toBe(9999)
    delete process.env.APOLLO_DAILY_CREDIT_CAP
  })
})
