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
const { mockCustomersCreate, mockCheckoutCreate, mockStripeCtor } = vi.hoisted(() => {
  const mockCustomersCreate = vi.fn()
  const mockCheckoutCreate = vi.fn()
  return {
    mockCustomersCreate,
    mockCheckoutCreate,
    mockStripeCtor: vi.fn(function () {
      this.customers = { create: mockCustomersCreate }
      this.checkout = { sessions: { create: mockCheckoutCreate } }
    }),
  }
})

vi.mock('../lib/auth.js', () => ({ getAuthedUser: mockGetAuthedUser }))
vi.mock('../lib/reportError.js', () => ({ reportServerError: mockReportServerError }))
vi.mock('@supabase/supabase-js', () => ({ createClient: mockCreateClient }))
vi.mock('stripe', () => ({ default: mockStripeCtor }))

function makeRequest(body, { method = 'POST' } = {}) {
  return new Request('https://annie.example/.netlify/functions/stripe-checkout', {
    method,
    body: method === 'GET' ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  })
}

let handler

beforeEach(async () => {
  vi.clearAllMocks()
  process.env.STRIPE_SECRET_KEY = 'sk_test_x'
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co'
  process.env.VITE_SUPABASE_ANON_KEY = 'anon_x'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service_role_x'
  process.env.STRIPE_PRICE_GROWTH_MONTHLY = 'price_solo_month'
  process.env.STRIPE_PRICE_TEAM_MONTHLY = 'price_team_month'

  mockGetAuthedUser.mockResolvedValue({ user: { id: 'user_123', email: 'a@b.com' }, error: null })
  mockMaybeSingle.mockResolvedValue({ data: null }) // no existing subscription row -> trial-eligible
  mockCustomersCreate.mockResolvedValue({ id: 'cus_new' })
  mockCheckoutCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/session/abc' })

  vi.resetModules()
  ;({ default: handler } = await import('../stripe-checkout.js'))
})

describe('method and configuration guards', () => {
  it('rejects non-POST methods', async () => {
    const res = await handler(makeRequest(null, { method: 'GET' }))
    expect(res.status).toBe(405)
  })

  it('returns 503 when billing is not configured', async () => {
    delete process.env.STRIPE_SECRET_KEY
    const res = await handler(makeRequest({ tier: 'solo', interval: 'month' }))
    expect(res.status).toBe(503)
  })
})

describe('authentication', () => {
  it('returns 401 for an unauthenticated caller', async () => {
    mockGetAuthedUser.mockResolvedValue({ user: null, error: 'invalid_session' })
    const res = await handler(makeRequest({ tier: 'solo', interval: 'month' }))
    expect(res.status).toBe(401)
    expect(mockCheckoutCreate).not.toHaveBeenCalled()
  })
})

describe('request validation', () => {
  it('returns 400 on an unparseable body', async () => {
    const res = await handler(makeRequest('not json'))
    expect(res.status).toBe(400)
  })

  it('returns 400 for an unknown or unconfigured tier', async () => {
    const res = await handler(makeRequest({ tier: 'nonexistent', interval: 'month' }))
    expect(res.status).toBe(400)
  })
})

describe('checkout session creation', () => {
  it('creates a new Stripe customer and starts a trial-eligible session for a first-time subscriber', async () => {
    const res = await handler(makeRequest({ tier: 'solo', interval: 'month' }))
    expect(res.status).toBe(200)
    expect(mockCustomersCreate).toHaveBeenCalledWith(expect.objectContaining({ email: 'a@b.com' }))
    expect(mockCheckoutCreate).toHaveBeenCalledWith(expect.objectContaining({
      customer: 'cus_new',
      client_reference_id: 'user_123',
      subscription_data: expect.objectContaining({ trial_period_days: 7 }),
    }))
    expect(await res.json()).toEqual({ url: 'https://checkout.stripe.com/session/abc' })
  })

  it('reuses an existing Stripe customer and is not trial-eligible for a returning subscriber', async () => {
    mockMaybeSingle.mockResolvedValue({ data: { stripe_customer_id: 'cus_existing' } })
    const res = await handler(makeRequest({ tier: 'solo', interval: 'month' }))
    expect(res.status).toBe(200)
    expect(mockCustomersCreate).not.toHaveBeenCalled()
    expect(mockCheckoutCreate).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_existing' }))
    const [[sessionArgs]] = mockCheckoutCreate.mock.calls
    expect(sessionArgs.subscription_data.trial_period_days).toBeUndefined()
  })

  it('enforces the 3-seat minimum with adjustable quantity for the team tier', async () => {
    const res = await handler(makeRequest({ tier: 'team', interval: 'month' }))
    expect(res.status).toBe(200)
    const [[sessionArgs]] = mockCheckoutCreate.mock.calls
    expect(sessionArgs.line_items[0].quantity).toBe(3)
    expect(sessionArgs.line_items[0].adjustable_quantity).toEqual({ enabled: true, minimum: 3, maximum: 100 })
  })

  it('reports and returns 500 when Stripe itself throws', async () => {
    mockCheckoutCreate.mockRejectedValue(new Error('stripe down'))
    const res = await handler(makeRequest({ tier: 'solo', interval: 'month' }))
    expect(res.status).toBe(500)
    expect(mockReportServerError).toHaveBeenCalled()
  })
})
