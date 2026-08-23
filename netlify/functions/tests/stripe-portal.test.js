import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetAuthedUser } = vi.hoisted(() => ({ mockGetAuthedUser: vi.fn() }))
const { mockReportServerError } = vi.hoisted(() => ({ mockReportServerError: vi.fn() }))
const { mockMaybeSingle, mockCreateClient } = vi.hoisted(() => {
  const mockMaybeSingle = vi.fn()
  const mockCreateClient = vi.fn(() => ({
    from: vi.fn(() => ({ select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: mockMaybeSingle })) })) })),
  }))
  return { mockMaybeSingle, mockCreateClient }
})
const { mockBillingPortalCreate, mockStripeCtor } = vi.hoisted(() => {
  const mockBillingPortalCreate = vi.fn()
  return {
    mockBillingPortalCreate,
    mockStripeCtor: vi.fn(function () { this.billingPortal = { sessions: { create: mockBillingPortalCreate } } }),
  }
})

vi.mock('../lib/auth.js', () => ({ getAuthedUser: mockGetAuthedUser }))
vi.mock('../lib/reportError.js', () => ({ reportServerError: mockReportServerError }))
vi.mock('@supabase/supabase-js', () => ({ createClient: mockCreateClient }))
vi.mock('stripe', () => ({ default: mockStripeCtor }))

function makeRequest(method = 'POST') {
  return new Request('https://annie.example/.netlify/functions/stripe-portal', { method })
}

let handler

beforeEach(async () => {
  vi.clearAllMocks()
  process.env.STRIPE_SECRET_KEY = 'sk_test_x'
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co'
  process.env.VITE_SUPABASE_ANON_KEY = 'anon_x'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service_role_x'
  mockGetAuthedUser.mockResolvedValue({ user: { id: 'user_123', email: 'a@b.com' }, error: null })
  mockMaybeSingle.mockResolvedValue({ data: { stripe_customer_id: 'cus_123' } })
  mockBillingPortalCreate.mockResolvedValue({ url: 'https://billing.stripe.com/session/abc' })
  vi.resetModules()
  ;({ default: handler } = await import('../stripe-portal.js'))
})

describe('method and configuration guards', () => {
  it('rejects non-POST methods', async () => {
    const res = await handler(makeRequest('GET'))
    expect(res.status).toBe(405)
  })

  it('returns 503 when billing is not configured', async () => {
    delete process.env.STRIPE_SECRET_KEY
    const res = await handler(makeRequest())
    expect(res.status).toBe(503)
  })
})

describe('authentication', () => {
  it('returns 401 for an unauthenticated caller', async () => {
    mockGetAuthedUser.mockResolvedValue({ user: null, error: 'invalid_session' })
    const res = await handler(makeRequest())
    expect(res.status).toBe(401)
    expect(mockBillingPortalCreate).not.toHaveBeenCalled()
  })
})

describe('billing portal session creation', () => {
  it('returns 400 when the caller has no Stripe customer on file yet', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null })
    const res = await handler(makeRequest())
    expect(res.status).toBe(400)
    expect(mockBillingPortalCreate).not.toHaveBeenCalled()
  })

  it('creates a portal session for the caller\'s own Stripe customer and returns its URL', async () => {
    const res = await handler(makeRequest())
    expect(res.status).toBe(200)
    expect(mockBillingPortalCreate).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_123' }))
    expect(await res.json()).toEqual({ url: 'https://billing.stripe.com/session/abc' })
  })

  it('reports and returns 500 when Stripe itself throws', async () => {
    mockBillingPortalCreate.mockRejectedValue(new Error('stripe down'))
    const res = await handler(makeRequest())
    expect(res.status).toBe(500)
    expect(mockReportServerError).toHaveBeenCalled()
  })
})
