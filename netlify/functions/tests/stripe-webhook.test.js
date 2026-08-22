// A production-readiness audit (2026-08-22) flagged this as the single
// highest-stakes untested HTTP handler in the app — it's the only writer of
// public.subscriptions, so a silent regression here means paying customers
// with no working subscription row. These tests cover the behaviours that
// audit specifically called out: signature verification is never skipped,
// a failed write actually returns 500 (so Stripe retries) instead of the
// always-200 bug that was fixed alongside this test file, redelivered
// events are deduped via stripe_webhook_events, and that idempotency
// record is only written on the success path.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockConstructEvent, mockSubscriptionsRetrieve } = vi.hoisted(() => ({
  mockConstructEvent: vi.fn(),
  mockSubscriptionsRetrieve: vi.fn(),
}))
const { mockCreateClient } = vi.hoisted(() => ({ mockCreateClient: vi.fn() }))
const { mockReportServerError } = vi.hoisted(() => ({ mockReportServerError: vi.fn() }))
const { mockSendPaymentFailedEmail } = vi.hoisted(() => ({ mockSendPaymentFailedEmail: vi.fn().mockResolvedValue() }))

vi.mock('stripe', () => ({
  // A plain `function` here, not an arrow — the real Stripe export is a
  // class invoked with `new Stripe(key)`, and arrow functions have no
  // [[Construct]] internal slot, so `new` on an arrow-based mock throws
  // "is not a constructor" even though it works fine called plainly.
  default: vi.fn().mockImplementation(function StripeMock() {
    return {
      webhooks: { constructEvent: mockConstructEvent },
      subscriptions: { retrieve: mockSubscriptionsRetrieve },
    }
  }),
}))
vi.mock('@supabase/supabase-js', () => ({ createClient: mockCreateClient }))
vi.mock('../lib/reportError.js', () => ({ reportServerError: mockReportServerError }))
vi.mock('../lib/email.js', () => ({ sendPaymentFailedEmail: mockSendPaymentFailedEmail }))

// Every query in this file is awaited either directly after the terminal
// method (upsert/insert) or after one more filter (.eq()) — both work
// against a single object that returns itself from every chain method and
// resolves to `result` when awaited, since `await` only ever needs `.then`.
function makeBuilder(result) {
  const builder = {}
  const chain = () => builder
  Object.assign(builder, {
    select: vi.fn(chain),
    eq: vi.fn(chain),
    not: vi.fn(chain),
    in: vi.fn(chain),
    order: vi.fn(chain),
    limit: vi.fn(chain),
    maybeSingle: vi.fn(chain),
    single: vi.fn(chain),
    upsert: vi.fn(chain),
    update: vi.fn(chain),
    insert: vi.fn(chain),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  })
  return builder
}

function makeSupabaseMock(overrides = {}) {
  return {
    from: vi.fn((table) => makeBuilder(overrides[table] ?? { data: null, error: null })),
  }
}

function makeRequest(body, { signature = 'valid-sig' } = {}) {
  return new Request('https://annie.example/api/stripe-webhook', {
    method: 'POST',
    headers: signature ? { 'stripe-signature': signature } : {},
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const CHECKOUT_EVENT = {
  id: 'evt_checkout_1',
  type: 'checkout.session.completed',
  data: { object: { client_reference_id: 'user_123', subscription: 'sub_123' } },
}

const SUBSCRIPTION_UPDATED_EVENT = {
  id: 'evt_updated_1',
  type: 'customer.subscription.updated',
  data: {
    object: {
      id: 'sub_123', customer: 'cus_123', status: 'active',
      items: { data: [{ price: { id: 'price_unknown' }, quantity: 1 }] },
      current_period_end: null, cancel_at_period_end: false,
    },
  },
}

const PAYMENT_FAILED_EVENT = {
  id: 'evt_failed_1',
  type: 'invoice.payment_failed',
  data: { object: { customer: 'cus_123', id: 'in_123', customer_email: 'client@example.com' } },
}

let handler

beforeEach(async () => {
  vi.clearAllMocks()
  process.env.STRIPE_SECRET_KEY = 'sk_test_x'
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x'
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service_role_x'
  mockSubscriptionsRetrieve.mockResolvedValue({
    id: 'sub_123',
    customer: 'cus_123',
    status: 'active',
    items: { data: [{ price: { id: 'price_unknown' }, quantity: 1 }] },
    current_period_end: null,
    cancel_at_period_end: false,
  })
  // Re-imported per test so the module's top-level nothing-cached behaviour
  // (it has none — every env read happens inside the handler) stays fresh;
  // vi.resetModules keeps this import isolated from mock state bleed.
  vi.resetModules()
  ;({ default: handler } = await import('../stripe-webhook.js'))
})

describe('method and configuration guards', () => {
  it('rejects non-POST requests', async () => {
    const req = new Request('https://annie.example/api/stripe-webhook', { method: 'GET' })
    const res = await handler(req)
    expect(res.status).toBe(405)
  })

  it('returns 200 without touching Stripe or Supabase when env vars are missing', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET
    mockCreateClient.mockReturnValue(makeSupabaseMock())
    const res = await handler(makeRequest({}))
    expect(res.status).toBe(200)
    expect(mockConstructEvent).not.toHaveBeenCalled()
  })
})

describe('signature verification', () => {
  it('never trusts a payload that fails signature verification', async () => {
    mockCreateClient.mockReturnValue(makeSupabaseMock())
    mockConstructEvent.mockImplementation(() => { throw new Error('signature mismatch') })
    const res = await handler(makeRequest({ id: 'evt_fake', type: 'checkout.session.completed' }))
    expect(res.status).toBe(400)
    // The whole point of the check: no Supabase write must happen off the
    // back of an unverified payload.
    expect(mockCreateClient).not.toHaveBeenCalled()
  })
})

describe('idempotency', () => {
  it('short-circuits a redelivered event without re-running any handler logic', async () => {
    mockConstructEvent.mockReturnValue(CHECKOUT_EVENT)
    mockCreateClient.mockReturnValue(makeSupabaseMock({
      stripe_webhook_events: { data: { event_id: CHECKOUT_EVENT.id }, error: null },
    }))
    const res = await handler(makeRequest(CHECKOUT_EVENT))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok (already processed)')
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled()
  })

  it('only records the idempotency row on the success path, not inside the catch block', async () => {
    mockConstructEvent.mockReturnValue(CHECKOUT_EVENT)
    const supabase = makeSupabaseMock({
      subscriptions: { data: null, error: { message: 'upsert failed' } },
    })
    mockCreateClient.mockReturnValue(supabase)
    const res = await handler(makeRequest(CHECKOUT_EVENT))
    expect(res.status).toBe(500)
    // stripe_webhook_events.insert is only ever reached on the success path;
    // on a thrown error the handler returns from inside the catch block
    // before that line runs.
    const webhookEventBuilders = supabase.from.mock.results
      .filter((_, i) => supabase.from.mock.calls[i][0] === 'stripe_webhook_events')
      .map(r => r.value)
    const insertCalls = webhookEventBuilders.flatMap(b => b.insert.mock.calls)
    expect(insertCalls.length).toBe(0)
  })
})

describe('checkout.session.completed', () => {
  it('creates the subscription row keyed by the checkout session user', async () => {
    mockConstructEvent.mockReturnValue(CHECKOUT_EVENT)
    const supabase = makeSupabaseMock()
    mockCreateClient.mockReturnValue(supabase)
    const res = await handler(makeRequest(CHECKOUT_EVENT))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
    const subscriptionsBuilder = supabase.from.mock.results.find(
      (_, i) => supabase.from.mock.calls[i][0] === 'subscriptions'
    ).value
    expect(subscriptionsBuilder.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'user_123', stripe_subscription_id: 'sub_123' }),
      { onConflict: 'user_id' }
    )
  })

  it('does nothing when the session has no client_reference_id (never silently mis-attributes a subscription)', async () => {
    const event = { ...CHECKOUT_EVENT, data: { object: { subscription: 'sub_123' } } }
    mockConstructEvent.mockReturnValue(event)
    const supabase = makeSupabaseMock()
    mockCreateClient.mockReturnValue(supabase)
    const res = await handler(makeRequest(event))
    expect(res.status).toBe(200)
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled()
  })

  it('returns 500 and reports the error when the upsert fails, so Stripe retries instead of losing the write silently', async () => {
    mockConstructEvent.mockReturnValue(CHECKOUT_EVENT)
    mockCreateClient.mockReturnValue(makeSupabaseMock({
      subscriptions: { data: null, error: { message: 'upsert failed' } },
    }))
    const res = await handler(makeRequest(CHECKOUT_EVENT))
    expect(res.status).toBe(500)
    expect(mockReportServerError).toHaveBeenCalledWith(
      'stripe-webhook', expect.any(Error), expect.objectContaining({ eventType: 'checkout.session.completed' })
    )
  })
})

describe('customer.subscription.updated / deleted', () => {
  it('re-syncs the subscription row from the live Stripe object', async () => {
    mockConstructEvent.mockReturnValue(SUBSCRIPTION_UPDATED_EVENT)
    const supabase = makeSupabaseMock()
    mockCreateClient.mockReturnValue(supabase)
    const res = await handler(makeRequest(SUBSCRIPTION_UPDATED_EVENT))
    expect(res.status).toBe(200)
    const subscriptionsBuilder = supabase.from.mock.results.find(
      (_, i) => supabase.from.mock.calls[i][0] === 'subscriptions'
    ).value
    expect(subscriptionsBuilder.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'active' }))
    expect(subscriptionsBuilder.eq).toHaveBeenCalledWith('stripe_subscription_id', 'sub_123')
  })
})

describe('invoice.payment_failed', () => {
  it('sends the Annie-branded payment-failed email without blocking the response', async () => {
    mockConstructEvent.mockReturnValue(PAYMENT_FAILED_EVENT)
    mockCreateClient.mockReturnValue(makeSupabaseMock())
    const res = await handler(makeRequest(PAYMENT_FAILED_EVENT))
    expect(res.status).toBe(200)
    expect(mockSendPaymentFailedEmail).toHaveBeenCalledWith('client@example.com')
  })
})

describe('unhandled event types', () => {
  it('acknowledges event types this endpoint does not act on', async () => {
    const event = { id: 'evt_other', type: 'customer.updated', data: { object: {} } }
    mockConstructEvent.mockReturnValue(event)
    mockCreateClient.mockReturnValue(makeSupabaseMock())
    const res = await handler(makeRequest(event))
    expect(res.status).toBe(200)
  })
})
