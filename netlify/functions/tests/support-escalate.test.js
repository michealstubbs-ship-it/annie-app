// support-escalate.js is a fire-and-forget side effect from SupportWidget.jsx
// (see src/lib/supportEscalation.js) — these tests cover: auth is enforced
// like every other customer-facing function, a firm-name lookup failure
// never blocks the actual email, an email-send failure is reported but
// still returns 200 (the customer's own chat already succeeded and should
// never be retried/broken by this), and the right recipient/category reach
// sendSupportEscalationEmail.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetAuthedUser } = vi.hoisted(() => ({ mockGetAuthedUser: vi.fn() }))
const { mockSendSupportEscalationEmail } = vi.hoisted(() => ({ mockSendSupportEscalationEmail: vi.fn() }))
const { mockReportServerError } = vi.hoisted(() => ({ mockReportServerError: vi.fn().mockResolvedValue(undefined) }))
const { mockInsert } = vi.hoisted(() => ({ mockInsert: vi.fn().mockResolvedValue({ error: null }) }))
const { mockCreateClient } = vi.hoisted(() => {
  function makeSelectBuilder(result) {
    const builder = { select: () => builder, eq: () => builder, maybeSingle: () => Promise.resolve(result) }
    return builder
  }
  // Same shared client mock backs both the firm-name lookup (select/eq/
  // maybeSingle) and the new support_escalations insert — a real Supabase
  // client's `from()` call supports both chains depending on what's called
  // next, so the mock needs to too, not just whichever one existing tests
  // happened to exercise first.
  return {
    mockCreateClient: vi.fn(() => ({
      from: () => ({ ...makeSelectBuilder({ data: { firm_name: 'Acme Recruiting' }, error: null }), insert: mockInsert }),
    })),
  }
})

vi.mock('../lib/auth.js', () => ({ getAuthedUser: mockGetAuthedUser }))
vi.mock('../lib/email.js', () => ({ sendSupportEscalationEmail: mockSendSupportEscalationEmail }))
vi.mock('../lib/reportError.js', () => ({ reportServerError: mockReportServerError }))
vi.mock('@supabase/supabase-js', () => ({ createClient: mockCreateClient }))

function makeRequest(body, { method = 'POST', invalidJson = false } = {}) {
  const init = { method }
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = invalidJson ? '{not json' : JSON.stringify(body ?? { category: 'refund_billing', excerpt: 'user: I want a refund' })
  }
  return new Request('https://annie.example/api/support-escalate', init)
}

let handler

beforeEach(async () => {
  vi.clearAllMocks()
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co'
  process.env.VITE_SUPABASE_ANON_KEY = 'anon_x'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service_role_x'
  delete process.env.SUPPORT_ESCALATION_EMAIL

  mockGetAuthedUser.mockResolvedValue({ user: { id: 'user_123', email: 'client@acme.com' }, error: null })
  mockSendSupportEscalationEmail.mockResolvedValue(true)
  mockInsert.mockResolvedValue({ error: null })
  // clearAllMocks only clears call history, not a return value/implementation
  // a previous test set via mockReturnValue/mockImplementation — reassign it
  // fresh every test so one test's override (e.g. the firm-lookup-failure
  // test below) can never leak into the next one.
  mockCreateClient.mockImplementation(() => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { firm_name: 'Acme Recruiting' }, error: null }) }) }),
      insert: mockInsert,
    }),
  }))

  vi.resetModules()
  ;({ default: handler } = await import('../support-escalate.js'))
})

it('rejects a non-POST request without touching auth', async () => {
  const resp = await handler(makeRequest(undefined, { method: 'GET' }))
  expect(resp.status).toBe(405)
  expect(mockGetAuthedUser).not.toHaveBeenCalled()
})

it('returns 401 when the caller is not authenticated, and never sends the email', async () => {
  mockGetAuthedUser.mockResolvedValue({ user: null, error: 'invalid_session' })
  const resp = await handler(makeRequest())
  expect(resp.status).toBe(401)
  expect(mockSendSupportEscalationEmail).not.toHaveBeenCalled()
})

it('returns 400 on an unparseable body, without reporting it as a server error', async () => {
  const resp = await handler(makeRequest(undefined, { invalidJson: true }))
  expect(resp.status).toBe(400)
  expect(mockReportServerError).not.toHaveBeenCalled()
})

it('sends the escalation email with the caller\'s verified email, looked-up firm name, category, and excerpt', async () => {
  const resp = await handler(makeRequest({ category: 'refund_billing', excerpt: 'user: I want a refund' }))
  expect(resp.status).toBe(200)
  expect(mockSendSupportEscalationEmail).toHaveBeenCalledWith('mstubbs@meetannie.ai', {
    customerEmail: 'client@acme.com',
    firmName: 'Acme Recruiting',
    category: 'refund_billing',
    excerpt: 'user: I want a refund',
  })
})

it('honors SUPPORT_ESCALATION_EMAIL when set, instead of the hardcoded default', async () => {
  process.env.SUPPORT_ESCALATION_EMAIL = 'ops@example.com'
  await handler(makeRequest())
  expect(mockSendSupportEscalationEmail).toHaveBeenCalledWith('ops@example.com', expect.anything())
})

it('defaults an unrecognized/missing category to "unresolved" rather than passing through anything the client sent', async () => {
  await handler(makeRequest({ excerpt: 'hi' }))
  expect(mockSendSupportEscalationEmail).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ category: 'unresolved' }))
})

it('truncates an excessively long excerpt to the last MAX_EXCERPT_CHARS characters', async () => {
  const longExcerpt = 'x'.repeat(5000) + 'END'
  await handler(makeRequest({ category: 'bug_report', excerpt: longExcerpt }))
  const sentExcerpt = mockSendSupportEscalationEmail.mock.calls[0][1].excerpt
  expect(sentExcerpt.length).toBe(4000)
  expect(sentExcerpt.endsWith('END')).toBe(true)
})

it('still returns 200 when the firm-name lookup fails — the email still sends with just the account email', async () => {
  mockCreateClient.mockReturnValue({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.reject(new Error('db down')) } ) }), insert: mockInsert }),
  })
  const resp = await handler(makeRequest())
  expect(resp.status).toBe(200)
  expect(mockReportServerError).toHaveBeenCalled()
})

it('writes a support_escalations row alongside the email, with the same fields', async () => {
  await handler(makeRequest({ category: 'refund_billing', excerpt: 'user: I want a refund' }))
  expect(mockInsert).toHaveBeenCalledWith({
    user_id: 'user_123',
    firm_name: 'Acme Recruiting',
    customer_email: 'client@acme.com',
    category: 'refund_billing',
    excerpt: 'user: I want a refund',
  })
})

it('still returns 200 and reports the failure when the support_escalations insert itself fails — the email already sent and should not be treated as failed', async () => {
  mockInsert.mockResolvedValue({ error: { message: 'insert denied' } })
  const resp = await handler(makeRequest())
  expect(resp.status).toBe(200)
  const body = await resp.json()
  expect(body.ok).toBe(true)
  expect(mockReportServerError).toHaveBeenCalledWith('support-escalate', expect.objectContaining({ message: expect.stringContaining('insert denied') }), expect.objectContaining({ userId: 'user_123' }))
})

it('never attempts the insert when there is no service key (no supabase client at all)', async () => {
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
  const resp = await handler(makeRequest())
  expect(resp.status).toBe(200)
  expect(mockInsert).not.toHaveBeenCalled()
})

it('reports but still returns 200 when sendSupportEscalationEmail resolves false (unconfigured/failed send)', async () => {
  mockSendSupportEscalationEmail.mockResolvedValue(false)
  const resp = await handler(makeRequest())
  expect(resp.status).toBe(200)
  const body = await resp.json()
  expect(body.ok).toBe(true)
  expect(mockReportServerError).toHaveBeenCalledWith('support-escalate', expect.any(Error), expect.objectContaining({ userId: 'user_123' }))
})

it('returns 500-safe {ok:false} rather than throwing when something in the try block itself throws', async () => {
  mockSendSupportEscalationEmail.mockRejectedValue(new Error('unexpected'))
  const resp = await handler(makeRequest())
  expect(resp.status).toBe(200)
  const body = await resp.json()
  expect(body.ok).toBe(false)
  expect(mockReportServerError).toHaveBeenCalled()
})
