// Entry point for meetannie.ai's marketing-site "Start free trial" buttons.
// The one behavior this file exists specifically to pin down: a normal
// signup MUST always collect a card up front, even during the trial — a
// real bug (2026-08-24) had every trial skip the card, not just ones using
// the free-month code, because `payment_method_collection: 'if_required'`
// looks at "is anything due today" and a trial alone already makes that
// true. See start-trial-checkout.js's own comment for the full story.
//
// 2026-08-25: the free-month code check no longer calls Stripe at all — an
// earlier version looked up a live Stripe promotion code, which broke
// silently in production the day that promotion code didn't actually exist
// in live Stripe (an incident this simplification exists to prevent from
// ever happening again). It's now a literal, case-insensitive string
// compare, so there's no external dependency and no Stripe mock needed for
// it — see the "annie100 case-insensitivity" test below for the one
// behavior that matters most from that change (Michael types it in caps).
//
// 2026-08-26: the free-month path now also checks a real redemption count
// against a cap (see start-trial-checkout.js's own header for why — the
// link has no expiry/rate-limit otherwise). That check is real Supabase
// I/O, mocked below the same way other function tests mock it.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockCheckoutCreate, mockStripeCtor } = vi.hoisted(() => {
  const mockCheckoutCreate = vi.fn()
  return {
    mockCheckoutCreate,
    mockStripeCtor: vi.fn(function () {
      this.checkout = { sessions: { create: mockCheckoutCreate } }
    }),
  }
})

const { mockCountQuery, mockCreateClient, mockAlertIfConfigured } = vi.hoisted(() => {
  const mockCountQuery = vi.fn()
  const mockCreateClient = vi.fn(() => ({
    from: () => ({ select: () => ({ eq: mockCountQuery }) }),
  }))
  const mockAlertIfConfigured = vi.fn()
  return { mockCountQuery, mockCreateClient, mockAlertIfConfigured }
})

vi.mock('stripe', () => ({ default: mockStripeCtor }))
vi.mock('@supabase/supabase-js', () => ({ createClient: mockCreateClient }))
vi.mock('../lib/scanShared.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, alertIfConfigured: mockAlertIfConfigured }
})

function makeRequest(query = '') {
  return new Request(`https://annie.example/api/start-trial-checkout${query}`, { method: 'GET' })
}

let handler

beforeEach(async () => {
  vi.clearAllMocks()
  process.env.STRIPE_SECRET_KEY = 'sk_test_x'
  process.env.APP_URL = 'https://app.example'
  process.env.MARKETING_URL = 'https://marketing.example'
  process.env.STRIPE_PRICE_STARTER_MONTHLY = 'price_starter_month'
  process.env.STRIPE_PRICE_GROWTH_MONTHLY = 'price_growth_month'
  process.env.STRIPE_PRICE_TEAM_MONTHLY = 'price_team_month'
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service_role_x'

  mockCheckoutCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/session/abc' })
  // Well under the default cap of 50 — the free-month path is allowed
  // through unless a specific test says otherwise.
  mockCountQuery.mockResolvedValue({ count: 3, error: null })

  vi.resetModules()
  ;({ default: handler } = await import('../start-trial-checkout.js'))
})

it('rejects an unknown tier before ever calling Stripe', async () => {
  const res = await handler(makeRequest('?tier=bogus&interval=month'))
  expect(res.status).toBe(400)
  expect(mockCheckoutCreate).not.toHaveBeenCalled()
})

it('rejects a tier with no configured price', async () => {
  delete process.env.STRIPE_PRICE_GROWTH_MONTHLY
  const res = await handler(makeRequest('?tier=growth&interval=month'))
  expect(res.status).toBe(400)
  expect(mockCheckoutCreate).not.toHaveBeenCalled()
})

it('always requires a card for a normal signup, even though the trial makes $0 due today', async () => {
  const res = await handler(makeRequest('?tier=starter&interval=month'))
  expect(res.status).toBe(302)
  expect(res.headers.get('Location')).toBe('https://checkout.stripe.com/session/abc')
  expect(mockCheckoutCreate).toHaveBeenCalledWith(expect.objectContaining({
    mode: 'subscription',
    payment_method_collection: 'always',
    allow_promotion_codes: true,
    subscription_data: expect.objectContaining({ trial_period_days: 7 }),
  }))
  const call = mockCheckoutCreate.mock.calls[0][0]
  expect(call.subscription_data.metadata.free_month_code).toBeUndefined()
  // A normal signup never even needs to count redemptions.
  expect(mockCountQuery).not.toHaveBeenCalled()
})

describe('the ANNIE100 free-month code', () => {
  it('skips the card and gives a 30-day trial for ?code=annie100, under the redemption cap', async () => {
    const res = await handler(makeRequest('?tier=starter&interval=month&code=annie100'))
    expect(res.status).toBe(302)
    expect(mockCheckoutCreate).toHaveBeenCalledWith(expect.objectContaining({
      payment_method_collection: 'if_required',
      allow_promotion_codes: true,
      subscription_data: expect.objectContaining({
        trial_period_days: 30,
        metadata: expect.objectContaining({ free_month_code: 'annie100' }),
      }),
    }))
  })

  // Michael's own real usage: he types the code in caps on Stripe's side,
  // so the link he hands out has to work regardless of case.
  it('matches regardless of case — ANNIE100, Annie100, annie100 all work', async () => {
    for (const code of ['ANNIE100', 'Annie100', 'annie100']) {
      mockCheckoutCreate.mockClear()
      const res = await handler(makeRequest(`?tier=starter&interval=month&code=${code}`))
      expect(res.status).toBe(302)
      expect(mockCheckoutCreate).toHaveBeenCalledWith(expect.objectContaining({ payment_method_collection: 'if_required' }))
    }
  })

  it('falls back to the normal card-required, 7-day flow for any other code', async () => {
    const res = await handler(makeRequest('?tier=starter&interval=month&code=not-a-real-code'))
    expect(res.status).toBe(302)
    expect(mockCheckoutCreate).toHaveBeenCalledWith(expect.objectContaining({
      payment_method_collection: 'always',
      subscription_data: expect.objectContaining({ trial_period_days: 7 }),
    }))
    // An unrecognized code isn't the free-month path at all — no reason
    // to spend a Supabase round-trip counting redemptions for it.
    expect(mockCountQuery).not.toHaveBeenCalled()
  })

  describe('redemption cap', () => {
    it('quietly falls back to the standard flow once the cap is reached, and alerts', async () => {
      mockCountQuery.mockResolvedValue({ count: 50, error: null }) // == default cap
      const res = await handler(makeRequest('?tier=starter&interval=month&code=annie100'))
      expect(res.status).toBe(302)
      expect(mockCheckoutCreate).toHaveBeenCalledWith(expect.objectContaining({
        payment_method_collection: 'always',
        subscription_data: expect.objectContaining({ trial_period_days: 7 }),
      }))
      expect(mockAlertIfConfigured).toHaveBeenCalledWith(expect.stringContaining('redemption cap'))
    })

    it('respects a FREE_MONTH_MAX_REDEMPTIONS override', async () => {
      process.env.FREE_MONTH_MAX_REDEMPTIONS = '2'
      mockCountQuery.mockResolvedValue({ count: 2, error: null })
      vi.resetModules()
      ;({ default: handler } = await import('../start-trial-checkout.js'))
      const res = await handler(makeRequest('?tier=starter&interval=month&code=annie100'))
      expect(mockCheckoutCreate).toHaveBeenCalledWith(expect.objectContaining({ payment_method_collection: 'always' }))
      delete process.env.FREE_MONTH_MAX_REDEMPTIONS
    })

    // 2026-08-26 audit finding: parseInt(env, 10) || DEFAULT silently
    // ignored an explicit "0" (falsy, so it fell through to the 50
    // default) — the one value an operator would actually set to
    // immediately retire the code. Now fixed via parseIntEnv (env.js).
    it('respects FREE_MONTH_MAX_REDEMPTIONS=0 as "retire the code now", not as unset', async () => {
      process.env.FREE_MONTH_MAX_REDEMPTIONS = '0'
      mockCountQuery.mockResolvedValue({ count: 0, error: null })
      vi.resetModules()
      ;({ default: handler } = await import('../start-trial-checkout.js'))
      const res = await handler(makeRequest('?tier=starter&interval=month&code=annie100'))
      expect(mockCheckoutCreate).toHaveBeenCalledWith(expect.objectContaining({ payment_method_collection: 'always' }))
      delete process.env.FREE_MONTH_MAX_REDEMPTIONS
    })

    it('fails closed (denies the free month, does not throw) when the redemption count query errors', async () => {
      mockCountQuery.mockResolvedValue({ count: null, error: { message: 'db down' } })
      const res = await handler(makeRequest('?tier=starter&interval=month&code=annie100'))
      expect(res.status).toBe(302)
      expect(mockCheckoutCreate).toHaveBeenCalledWith(expect.objectContaining({ payment_method_collection: 'always' }))
    })

    it('fails closed when Supabase is not configured, rather than allowing unlimited free months', async () => {
      delete process.env.VITE_SUPABASE_URL
      vi.resetModules()
      ;({ default: handler } = await import('../start-trial-checkout.js'))
      const res = await handler(makeRequest('?tier=starter&interval=month&code=annie100'))
      expect(mockCheckoutCreate).toHaveBeenCalledWith(expect.objectContaining({ payment_method_collection: 'always' }))
    })
  })
})

it('sets team seats to the 3-seat minimum with adjustable quantity', async () => {
  await handler(makeRequest('?tier=team&interval=month'))
  const call = mockCheckoutCreate.mock.calls[0][0]
  expect(call.line_items[0].quantity).toBe(3)
  expect(call.line_items[0].adjustable_quantity).toEqual({ enabled: true, minimum: 3, maximum: 100 })
})

it('returns 503 without calling Stripe when billing is not configured', async () => {
  delete process.env.STRIPE_SECRET_KEY
  vi.resetModules()
  ;({ default: handler } = await import('../start-trial-checkout.js'))
  const res = await handler(makeRequest('?tier=starter&interval=month'))
  expect(res.status).toBe(503)
  expect(mockCheckoutCreate).not.toHaveBeenCalled()
})

it('returns 500 when Stripe itself errors', async () => {
  mockCheckoutCreate.mockRejectedValue(new Error('stripe is down'))
  const res = await handler(makeRequest('?tier=starter&interval=month'))
  expect(res.status).toBe(500)
})
