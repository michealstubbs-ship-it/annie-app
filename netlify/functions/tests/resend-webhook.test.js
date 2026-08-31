// resend-webhook.js closes the "did the invoice email actually arrive" gap
// — these tests cover: signature verification is never skipped (including a
// stale timestamp), redelivered events are deduped via
// resend_webhook_events the same way stripe-webhook.js dedupes its own
// events, an unmatched email_id is a harmless no-op (most Resend sends
// aren't invoices), and a bounced/complained status is never silently
// overwritten by a later/out-of-order delivered event.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHmac } from 'node:crypto'

const { mockCreateClient } = vi.hoisted(() => ({ mockCreateClient: vi.fn() }))
const { mockReportServerError } = vi.hoisted(() => ({ mockReportServerError: vi.fn().mockResolvedValue(undefined) }))
const { mockAlertIfConfigured } = vi.hoisted(() => ({ mockAlertIfConfigured: vi.fn().mockResolvedValue(undefined) }))

vi.mock('@supabase/supabase-js', () => ({ createClient: mockCreateClient }))
vi.mock('../lib/reportError.js', () => ({ reportServerError: mockReportServerError }))
vi.mock('../lib/scanShared.js', () => ({ alertIfConfigured: mockAlertIfConfigured, createTimeoutFetch: () => fetch }))

const SECRET = 'whsec_dGVzdHNlY3JldGtleWJ5dGVzMTIzNDU2Nzg=' // base64 after the whsec_ prefix

function sign({ id, timestamp, body, secret = SECRET }) {
  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const signedContent = `${id}.${timestamp}.${body}`
  const sig = createHmac('sha256', secretBytes).update(signedContent, 'utf8').digest('base64')
  return `v1,${sig}`
}

function makeRequest(payload, { id = 'msg_1', timestamp = Math.floor(Date.now() / 1000).toString(), badSignature = false, omitSignature = false, method = 'POST' } = {}) {
  const body = JSON.stringify(payload)
  const headers = {}
  if (!omitSignature) {
    headers['svix-id'] = id
    headers['svix-timestamp'] = timestamp
    headers['svix-signature'] = badSignature ? 'v1,not-a-real-signature==' : sign({ id, timestamp, body })
  }
  const init = { method, headers }
  if (method !== 'GET' && method !== 'HEAD') init.body = body
  return new Request('https://annie.example/.netlify/functions/resend-webhook', init)
}

function makeBuilder(result) {
  const builder = {}
  const chain = () => builder
  Object.assign(builder, {
    select: vi.fn(chain),
    eq: vi.fn(chain),
    maybeSingle: vi.fn(chain),
    insert: vi.fn(chain),
    update: vi.fn(chain),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  })
  return builder
}

// invoices needs two different chains per request (the maybeSingle lookup,
// then the status update) — from() returns the right one by call order,
// same pattern send-invoice.test.js already uses for its own two-call table.
function makeSupabaseMock({ insertResult = { error: null }, invoiceResult = { data: { id: 'inv_1', email_delivery_status: null }, error: null }, updateResult = { error: null } } = {}) {
  let invoicesCallCount = 0
  const lookupBuilder = makeBuilder(invoiceResult)
  const updateBuilder = makeBuilder(updateResult)
  return {
    from: vi.fn((table) => {
      if (table === 'resend_webhook_events') return makeBuilder(insertResult)
      if (table === 'invoices') {
        invoicesCallCount += 1
        return invoicesCallCount === 1 ? lookupBuilder : updateBuilder
      }
      throw new Error(`unexpected table ${table}`)
    }),
    _lookupBuilder: lookupBuilder,
    _updateBuilder: updateBuilder,
  }
}

let handler

beforeEach(async () => {
  vi.clearAllMocks()
  process.env.RESEND_WEBHOOK_SECRET = SECRET
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service_role_x'
  mockCreateClient.mockReturnValue(makeSupabaseMock())
  vi.resetModules()
  ;({ default: handler } = await import('../resend-webhook.js'))
})

describe('method and configuration guards', () => {
  it('rejects non-POST methods', async () => {
    const res = await handler(makeRequest({ type: 'email.delivered', data: { email_id: 'e_1' } }, { method: 'GET' }))
    expect(res.status).toBe(405)
  })

  it('returns 200 "Not configured" and does nothing when RESEND_WEBHOOK_SECRET is unset', async () => {
    delete process.env.RESEND_WEBHOOK_SECRET
    vi.resetModules()
    ;({ default: handler } = await import('../resend-webhook.js'))
    const res = await handler(makeRequest({ type: 'email.delivered', data: { email_id: 'e_1' } }))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('Not configured')
    expect(mockCreateClient).not.toHaveBeenCalled()
  })
})

describe('signature verification', () => {
  it('rejects a request with no signature headers at all', async () => {
    const res = await handler(makeRequest({ type: 'email.delivered', data: { email_id: 'e_1' } }, { omitSignature: true }))
    expect(res.status).toBe(400)
    expect(mockCreateClient).not.toHaveBeenCalled()
  })

  it('rejects a request with a wrong signature', async () => {
    const res = await handler(makeRequest({ type: 'email.delivered', data: { email_id: 'e_1' } }, { badSignature: true }))
    expect(res.status).toBe(400)
    expect(mockCreateClient).not.toHaveBeenCalled()
  })

  it('rejects a request whose timestamp is too far in the past (replay protection)', async () => {
    const staleTimestamp = (Math.floor(Date.now() / 1000) - 600).toString() // 10 minutes old
    const res = await handler(makeRequest({ type: 'email.delivered', data: { email_id: 'e_1' } }, { timestamp: staleTimestamp }))
    expect(res.status).toBe(400)
  })

  it('accepts a correctly signed, fresh request', async () => {
    const res = await handler(makeRequest({ type: 'email.delivered', data: { email_id: 'e_1' } }))
    expect(res.status).toBe(200)
  })
})

describe('idempotency', () => {
  it('acks with 200 and does no further work when the event was already processed (unique-violation on event_id)', async () => {
    const supabase = makeSupabaseMock({ insertResult: { error: { code: '23505', message: 'duplicate key' } } })
    mockCreateClient.mockReturnValue(supabase)
    const res = await handler(makeRequest({ type: 'email.delivered', data: { email_id: 'e_1' } }))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('already processed')
  })
})

describe('event handling', () => {
  it('ignores an event type this endpoint does not track (e.g. email.opened)', async () => {
    const res = await handler(makeRequest({ type: 'email.opened', data: { email_id: 'e_1' } }))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('ignored')
  })

  it('is a harmless no-op when no invoice matches the email_id (most Resend sends are not invoices)', async () => {
    const supabase = makeSupabaseMock({ invoiceResult: { data: null, error: null } })
    mockCreateClient.mockReturnValue(supabase)
    const res = await handler(makeRequest({ type: 'email.delivered', data: { email_id: 'e_unmatched' } }))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('no matching invoice')
  })

  it('updates email_delivery_status to delivered on email.delivered', async () => {
    const supabase = makeSupabaseMock()
    mockCreateClient.mockReturnValue(supabase)
    await handler(makeRequest({ type: 'email.delivered', data: { email_id: 'e_1' } }))
    expect(supabase._updateBuilder.update).toHaveBeenCalledWith(expect.objectContaining({ email_delivery_status: 'delivered' }))
  })

  it('updates to bounced on email.bounced', async () => {
    const supabase = makeSupabaseMock()
    mockCreateClient.mockReturnValue(supabase)
    await handler(makeRequest({ type: 'email.bounced', data: { email_id: 'e_1' } }))
    expect(supabase._updateBuilder.update).toHaveBeenCalledWith(expect.objectContaining({ email_delivery_status: 'bounced' }))
  })

  it('updates to complained on email.complained and pages via alertIfConfigured', async () => {
    const supabase = makeSupabaseMock()
    mockCreateClient.mockReturnValue(supabase)
    await handler(makeRequest({ type: 'email.complained', data: { email_id: 'e_1' } }))
    expect(supabase._updateBuilder.update).toHaveBeenCalledWith(expect.objectContaining({ email_delivery_status: 'complained' }))
    expect(mockAlertIfConfigured).toHaveBeenCalledWith(expect.stringContaining('spam'))
  })

  it('does not page for a plain delivered event', async () => {
    await handler(makeRequest({ type: 'email.delivered', data: { email_id: 'e_1' } }))
    expect(mockAlertIfConfigured).not.toHaveBeenCalled()
  })

  // 2026-08-31 audit fix: a bounced/complained status is the actionable
  // truth about a send — a later, out-of-order 'delivered' or
  // 'delivery_delayed' event must never silently make a genuinely failed
  // send look fine again.
  it('does not let a later delivered event overwrite an existing bounced status', async () => {
    const supabase = makeSupabaseMock({ invoiceResult: { data: { id: 'inv_1', email_delivery_status: 'bounced' }, error: null } })
    mockCreateClient.mockReturnValue(supabase)
    const res = await handler(makeRequest({ type: 'email.delivered', data: { email_id: 'e_1' } }))
    expect(res.status).toBe(200)
    expect(supabase._updateBuilder.update).not.toHaveBeenCalled()
  })

  it('does not let a later delivered event overwrite an existing complained status', async () => {
    const supabase = makeSupabaseMock({ invoiceResult: { data: { id: 'inv_1', email_delivery_status: 'complained' }, error: null } })
    mockCreateClient.mockReturnValue(supabase)
    await handler(makeRequest({ type: 'email.delivered', data: { email_id: 'e_1' } }))
    expect(supabase._updateBuilder.update).not.toHaveBeenCalled()
  })

  it('still allows a bounced event to overwrite an existing bounced status (no-op update is fine)', async () => {
    const supabase = makeSupabaseMock({ invoiceResult: { data: { id: 'inv_1', email_delivery_status: 'bounced' }, error: null } })
    mockCreateClient.mockReturnValue(supabase)
    await handler(makeRequest({ type: 'email.bounced', data: { email_id: 'e_1' } }))
    expect(supabase._updateBuilder.update).toHaveBeenCalledWith(expect.objectContaining({ email_delivery_status: 'bounced' }))
  })
})

describe('failure handling', () => {
  it('reports and still acks 200 when the invoice lookup throws', async () => {
    const supabase = makeSupabaseMock({ invoiceResult: { data: null, error: { message: 'db down' } } })
    mockCreateClient.mockReturnValue(supabase)
    const res = await handler(makeRequest({ type: 'email.delivered', data: { email_id: 'e_1' } }))
    expect(res.status).toBe(200)
    expect(mockReportServerError).toHaveBeenCalled()
  })
})
