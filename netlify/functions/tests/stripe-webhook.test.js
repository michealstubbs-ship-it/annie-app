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

const { mockConstructEvent, mockSubscriptionsRetrieve, mockCustomersRetrieve } = vi.hoisted(() => ({
  mockConstructEvent: vi.fn(),
  mockSubscriptionsRetrieve: vi.fn(),
  mockCustomersRetrieve: vi.fn(),
}))
const { mockCreateClient } = vi.hoisted(() => ({ mockCreateClient: vi.fn() }))
const { mockReportServerError } = vi.hoisted(() => ({ mockReportServerError: vi.fn() }))
const { mockSendPaymentFailedEmail, mockSendAddCardToContinueEmail } = vi.hoisted(() => ({
  mockSendPaymentFailedEmail: vi.fn().mockResolvedValue(),
  mockSendAddCardToContinueEmail: vi.fn().mockResolvedValue(),
}))

vi.mock('stripe', () => ({
  // A plain `function` here, not an arrow — the real Stripe export is a
  // class invoked with `new Stripe(key)`, and arrow functions have no
  // [[Construct]] internal slot, so `new` on an arrow-based mock throws
  // "is not a constructor" even though it works fine called plainly.
  default: vi.fn().mockImplementation(function StripeMock() {
    return {
      webhooks: { constructEvent: mockConstructEvent },
      subscriptions: { retrieve: mockSubscriptionsRetrieve },
      customers: { retrieve: mockCustomersRetrieve },
    }
  }),
}))
vi.mock('@supabase/supabase-js', () => ({ createClient: mockCreateClient }))
vi.mock('../lib/reportError.js', () => ({ reportServerError: mockReportServerError }))
vi.mock('../lib/email.js', () => ({
  sendPaymentFailedEmail: mockSendPaymentFailedEmail,
  sendAddCardToContinueEmail: mockSendAddCardToContinueEmail,
}))

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
    ilike: vi.fn(chain),
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

// checkout.session.completed (2026-08-24) looks up the buyer's active team
// before writing the subscription row. Every existing test just needs that
// lookup to succeed, so it defaults to "found a team" here rather than
// every one of them having to know this lookup exists — see the
// "resolves the buyer's team" tests below for the cases that actually care.
const DEFAULT_TABLE_RESULTS = {
  team_members: { data: { team_id: 'team_abc' }, error: null },
}

function makeSupabaseMock(overrides = {}) {
  const results = { ...DEFAULT_TABLE_RESULTS, ...overrides }
  return {
    from: vi.fn((table) => makeBuilder(results[table] ?? { data: null, error: null })),
    // 2026-08-24: only exercised by the marketing-site checkout path below
    // (no client_reference_id — the webhook resolves/creates the account by
    // email instead). Every test that doesn't touch that path never calls
    // this, so a harmless default is fine; tests that do care override the
    // resolved value directly on the returned mock.
    auth: { admin: { inviteUserByEmail: vi.fn().mockResolvedValue({ data: { user: { id: 'user_invited' } }, error: null }) } },
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
      expect.objectContaining({ user_id: 'user_123', stripe_subscription_id: 'sub_123', team_id: 'team_abc' }),
      { onConflict: 'user_id' }
    )
  })

  it('reports and returns 500 when the buyer has no active team (should never happen post-signup, but must never silently write an unscoped subscription)', async () => {
    mockConstructEvent.mockReturnValue(CHECKOUT_EVENT)
    mockCreateClient.mockReturnValue(makeSupabaseMock({ team_members: { data: null, error: null } }))
    const res = await handler(makeRequest(CHECKOUT_EVENT))
    expect(res.status).toBe(500)
    expect(mockReportServerError).toHaveBeenCalledWith(
      'stripe-webhook', expect.any(Error), expect.objectContaining({ eventType: 'checkout.session.completed' })
    )
  })

  // 2026-08-24: a session with no client_reference_id used to always mean
  // "never happens, do nothing" — now it's the NORMAL case for a
  // marketing-site checkout (start-trial-checkout.js has no logged-in user
  // to set it from), so the handler resolves/creates the account by email
  // instead. Only a session with neither a client_reference_id nor any
  // email genuinely can't be attributed to anyone — that's the one case
  // left that must fail loudly rather than silently mis-attribute or
  // silently drop a paying customer.
  it('returns 500 when the session has neither a client_reference_id nor an email (can never attribute the subscription to anyone)', async () => {
    const event = { ...CHECKOUT_EVENT, data: { object: { subscription: 'sub_123' } } }
    mockConstructEvent.mockReturnValue(event)
    const supabase = makeSupabaseMock()
    mockCreateClient.mockReturnValue(supabase)
    const res = await handler(makeRequest(event))
    expect(res.status).toBe(500)
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled()
    expect(mockReportServerError).toHaveBeenCalledWith(
      'stripe-webhook', expect.any(Error), expect.objectContaining({ eventType: 'checkout.session.completed' })
    )
  })

  it('resolves an existing Annie account by email when client_reference_id is missing (marketing-site checkout, returning customer)', async () => {
    const event = {
      ...CHECKOUT_EVENT,
      data: { object: { subscription: 'sub_123', customer_details: { email: 'buyer@example.com' } } },
    }
    mockConstructEvent.mockReturnValue(event)
    const supabase = makeSupabaseMock({ profiles: { data: { id: 'user_existing' }, error: null } })
    mockCreateClient.mockReturnValue(supabase)
    const res = await handler(makeRequest(event))
    expect(res.status).toBe(200)
    expect(supabase.auth.admin.inviteUserByEmail).not.toHaveBeenCalled()
    const subscriptionsBuilder = supabase.from.mock.results.find(
      (_, i) => supabase.from.mock.calls[i][0] === 'subscriptions'
    ).value
    expect(subscriptionsBuilder.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'user_existing', team_id: 'team_abc' }),
      { onConflict: 'user_id' }
    )
  })

  it('invites a brand-new account by email when client_reference_id is missing and no existing profile matches (marketing-site checkout, new customer)', async () => {
    const event = {
      ...CHECKOUT_EVENT,
      data: { object: { subscription: 'sub_123', customer_details: { email: 'newbuyer@example.com' } } },
    }
    mockConstructEvent.mockReturnValue(event)
    const supabase = makeSupabaseMock({ profiles: { data: null, error: null } })
    mockCreateClient.mockReturnValue(supabase)
    const res = await handler(makeRequest(event))
    expect(res.status).toBe(200)
    expect(supabase.auth.admin.inviteUserByEmail).toHaveBeenCalledWith(
      'newbuyer@example.com',
      expect.objectContaining({ redirectTo: expect.stringContaining('/reset-password') })
    )
    const subscriptionsBuilder = supabase.from.mock.results.find(
      (_, i) => supabase.from.mock.calls[i][0] === 'subscriptions'
    ).value
    expect(subscriptionsBuilder.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'user_invited', team_id: 'team_abc' }),
      { onConflict: 'user_id' }
    )
  })

  it('returns 500 and reports the error when inviting the new customer fails', async () => {
    const event = {
      ...CHECKOUT_EVENT,
      data: { object: { subscription: 'sub_123', customer_details: { email: 'newbuyer@example.com' } } },
    }
    mockConstructEvent.mockReturnValue(event)
    const supabase = makeSupabaseMock({ profiles: { data: null, error: null } })
    supabase.auth.admin.inviteUserByEmail.mockResolvedValue({ data: null, error: { message: 'invite failed' } })
    mockCreateClient.mockReturnValue(supabase)
    const res = await handler(makeRequest(event))
    expect(res.status).toBe(500)
    expect(mockReportServerError).toHaveBeenCalledWith(
      'stripe-webhook', expect.any(Error), expect.objectContaining({ eventType: 'checkout.session.completed' })
    )
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
    expect(mockSendAddCardToContinueEmail).not.toHaveBeenCalled()
  })

  // 2026-08-25: the ANNIE100 free-month flow's whole point is a subscription
  // that reaches this exact event with no card ever having been on file —
  // sendPaymentFailedEmail's "we weren't able to charge your card" copy
  // would be wrong for that case. This is the regression test for the fix.
  it('routes to sendAddCardToContinueEmail instead when the subscription has no payment method on file', async () => {
    const event = {
      id: 'evt_failed_no_card',
      type: 'invoice.payment_failed',
      data: { object: { customer: 'cus_123', id: 'in_123', customer_email: 'client@example.com', subscription: 'sub_123' } },
    }
    mockConstructEvent.mockReturnValue(event)
    mockCreateClient.mockReturnValue(makeSupabaseMock())
    mockSubscriptionsRetrieve.mockResolvedValue({ id: 'sub_123', default_payment_method: null })
    const res = await handler(makeRequest(event))
    expect(res.status).toBe(200)
    expect(mockSendAddCardToContinueEmail).toHaveBeenCalledWith('client@example.com', { endingSoon: false })
    expect(mockSendPaymentFailedEmail).not.toHaveBeenCalled()
  })

  it('still sends the normal payment-failed email when a real card is on file and just got declined', async () => {
    const event = {
      id: 'evt_failed_real_card',
      type: 'invoice.payment_failed',
      data: { object: { customer: 'cus_123', id: 'in_123', customer_email: 'client@example.com', subscription: 'sub_123' } },
    }
    mockConstructEvent.mockReturnValue(event)
    mockCreateClient.mockReturnValue(makeSupabaseMock())
    mockSubscriptionsRetrieve.mockResolvedValue({ id: 'sub_123', default_payment_method: 'pm_123' })
    const res = await handler(makeRequest(event))
    expect(res.status).toBe(200)
    expect(mockSendPaymentFailedEmail).toHaveBeenCalledWith('client@example.com')
    expect(mockSendAddCardToContinueEmail).not.toHaveBeenCalled()
  })
})

describe('customer.subscription.trial_will_end', () => {
  // Only actionable for the ANNIE100 free-month flow — a normal signup
  // already has a card, so its trial ending just auto-charges on schedule.
  it('sends an early heads-up when there is no payment method on file yet', async () => {
    const event = {
      id: 'evt_trial_end_1',
      type: 'customer.subscription.trial_will_end',
      data: { object: { id: 'sub_123', customer: 'cus_123', default_payment_method: null } },
    }
    mockConstructEvent.mockReturnValue(event)
    mockCreateClient.mockReturnValue(makeSupabaseMock())
    mockCustomersRetrieve.mockResolvedValue({ id: 'cus_123', email: 'client@example.com', deleted: false })
    const res = await handler(makeRequest(event))
    expect(res.status).toBe(200)
    expect(mockSendAddCardToContinueEmail).toHaveBeenCalledWith('client@example.com', { endingSoon: true })
  })

  it('does nothing for a subscription that already has a card on file', async () => {
    const event = {
      id: 'evt_trial_end_2',
      type: 'customer.subscription.trial_will_end',
      data: { object: { id: 'sub_123', customer: 'cus_123', default_payment_method: 'pm_123' } },
    }
    mockConstructEvent.mockReturnValue(event)
    mockCreateClient.mockReturnValue(makeSupabaseMock())
    const res = await handler(makeRequest(event))
    expect(res.status).toBe(200)
    expect(mockCustomersRetrieve).not.toHaveBeenCalled()
    expect(mockSendAddCardToContinueEmail).not.toHaveBeenCalled()
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
