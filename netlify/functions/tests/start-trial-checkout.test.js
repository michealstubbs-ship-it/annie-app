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

vi.mock('stripe', () => ({ default: mockStripeCtor }))

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

  mockCheckoutCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/session/abc' })

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
})

describe('the ANNIE100 free-month code', () => {
  it('skips the card and gives a 30-day trial for ?code=annie100', async () => {
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
