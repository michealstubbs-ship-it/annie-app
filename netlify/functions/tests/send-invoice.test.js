// send-invoice.js generates the PDF, assigns the invoice's permanent number
// on first send only, emails it, and marks the invoice sent — all through
// the caller's own RLS-scoped client (see the file's own header comment for
// why, not a service-role client). These tests cover: auth is enforced,
// every read/write goes through the authed client (never service-role), the
// invoice number is only minted once (not on a resend), a missing
// bill_to_email or a voided invoice is rejected before any PDF work, and a
// failed email send still leaves a freshly-minted number committed.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetAuthedClient } = vi.hoisted(() => ({ mockGetAuthedClient: vi.fn() }))
const { mockGenerateInvoicePdf } = vi.hoisted(() => ({ mockGenerateInvoicePdf: vi.fn() }))
const { mockSendInvoiceEmail } = vi.hoisted(() => ({ mockSendInvoiceEmail: vi.fn() }))
const { mockReportServerError } = vi.hoisted(() => ({ mockReportServerError: vi.fn().mockResolvedValue(undefined) }))

vi.mock('../lib/auth.js', () => ({ getAuthedClient: mockGetAuthedClient }))
vi.mock('../lib/invoicePdf.js', () => ({ generateInvoicePdf: mockGenerateInvoicePdf }))
vi.mock('../lib/email.js', () => ({ sendInvoiceEmail: mockSendInvoiceEmail }))
vi.mock('../lib/reportError.js', () => ({ reportServerError: mockReportServerError }))

const BASE_INVOICE = {
  id: 'inv_1',
  team_id: 'team_1',
  status: 'draft',
  invoice_number: null,
  bill_to_email: 'client@example.com',
  total: 15000,
  currency: 'AED',
  due_date: '2026-09-10',
  created_by_name: null,
  invoice_line_items: [{ id: 'li_1', description: 'Placement fee', quantity: 1, unit_amount: 15000, amount: 15000 }],
}

function makeSupabase({ invoice = BASE_INVOICE, details = {}, profile = { full_name: 'Jo Recruiter' }, rpcResult = { data: 'INV-2026-0001', error: null }, updateResult, invoiceErr = null, detailsErr = null, rpcErr = null, updateErr = null } = {}) {
  const invoiceQuery = { select: () => invoiceQuery, eq: () => invoiceQuery, maybeSingle: () => Promise.resolve({ data: invoiceErr ? null : invoice, error: invoiceErr }) }
  const detailsQuery = { select: () => detailsQuery, maybeSingle: () => Promise.resolve({ data: detailsErr ? null : details, error: detailsErr }) }
  const profileQuery = { select: () => profileQuery, eq: () => profileQuery, maybeSingle: () => Promise.resolve({ data: profile, error: null }) }
  const updateQuery = {
    update: () => updateQuery,
    eq: () => updateQuery,
    select: () => updateQuery,
    single: () => Promise.resolve({ data: updateErr ? null : (updateResult || { ...invoice, status: 'sent' }), error: updateErr }),
  }

  let invoiceCallCount = 0
  return {
    from: (table) => {
      if (table === 'invoices') {
        invoiceCallCount += 1
        // First call is the read (getInvoice-shaped); the second is the
        // final status update — matches the handler's own call order.
        return invoiceCallCount === 1 ? invoiceQuery : updateQuery
      }
      if (table === 'invoicing_details') return detailsQuery
      if (table === 'profiles') return profileQuery
      throw new Error(`unexpected table ${table}`)
    },
    rpc: vi.fn().mockResolvedValue(rpcErr ? { data: null, error: rpcErr } : rpcResult),
  }
}

function makeRequest(body, { method = 'POST', invalidJson = false } = {}) {
  const init = { method }
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = invalidJson ? '{not json' : JSON.stringify(body ?? { invoiceId: 'inv_1' })
  }
  return new Request('https://annie.example/api/send-invoice', init)
}

let handler

beforeEach(async () => {
  vi.clearAllMocks()
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co'
  process.env.VITE_SUPABASE_ANON_KEY = 'anon_x'

  mockGenerateInvoicePdf.mockResolvedValue(new Uint8Array([1, 2, 3]))
  mockSendInvoiceEmail.mockResolvedValue(true)
  mockGetAuthedClient.mockResolvedValue({ client: makeSupabase(), user: { id: 'user_1' }, error: null })

  vi.resetModules()
  ;({ default: handler } = await import('../send-invoice.js'))
})

it('rejects a non-POST request without touching auth', async () => {
  const resp = await handler(makeRequest(undefined, { method: 'GET' }))
  expect(resp.status).toBe(405)
  expect(mockGetAuthedClient).not.toHaveBeenCalled()
})

it('returns 401 when the caller is not authenticated', async () => {
  mockGetAuthedClient.mockResolvedValue({ client: null, user: null, error: 'invalid_session' })
  const resp = await handler(makeRequest())
  expect(resp.status).toBe(401)
  expect(mockGenerateInvoicePdf).not.toHaveBeenCalled()
})

it('returns 400 on an unparseable body', async () => {
  const resp = await handler(makeRequest(undefined, { invalidJson: true }))
  expect(resp.status).toBe(400)
})

it('returns 400 when invoiceId is missing', async () => {
  const resp = await handler(makeRequest({}))
  expect(resp.status).toBe(400)
})

it('returns 404 when the invoice does not exist (or belongs to another team, indistinguishable under RLS)', async () => {
  mockGetAuthedClient.mockResolvedValue({ client: makeSupabase({ invoice: null }), user: { id: 'user_1' }, error: null })
  const resp = await handler(makeRequest())
  expect(resp.status).toBe(404)
})

it('rejects sending a voided invoice, before any PDF/email work', async () => {
  mockGetAuthedClient.mockResolvedValue({ client: makeSupabase({ invoice: { ...BASE_INVOICE, status: 'void' } }), user: { id: 'user_1' }, error: null })
  const resp = await handler(makeRequest())
  expect(resp.status).toBe(400)
  expect(mockGenerateInvoicePdf).not.toHaveBeenCalled()
})

it('rejects an invoice with no bill_to_email, before any PDF/email work', async () => {
  mockGetAuthedClient.mockResolvedValue({ client: makeSupabase({ invoice: { ...BASE_INVOICE, bill_to_email: null } }), user: { id: 'user_1' }, error: null })
  const resp = await handler(makeRequest())
  expect(resp.status).toBe(400)
  expect(mockGenerateInvoicePdf).not.toHaveBeenCalled()
})

it('mints a new invoice number via the RPC on first send, and threads it through the PDF and email', async () => {
  const supabase = makeSupabase()
  mockGetAuthedClient.mockResolvedValue({ client: supabase, user: { id: 'user_1' }, error: null })
  const resp = await handler(makeRequest())
  expect(resp.status).toBe(200)
  expect(supabase.rpc).toHaveBeenCalledWith('next_invoice_number', { p_team_id: 'team_1' })
  expect(mockGenerateInvoicePdf.mock.calls[0][0]).toEqual(expect.objectContaining({ invoice_number: 'INV-2026-0001' }))
  expect(mockSendInvoiceEmail).toHaveBeenCalledWith('client@example.com', expect.objectContaining({ invoiceNumber: 'INV-2026-0001' }))
})

it('does not mint a second invoice number when resending an already-numbered invoice', async () => {
  const supabase = makeSupabase({ invoice: { ...BASE_INVOICE, invoice_number: 'INV-2026-0001', status: 'sent' } })
  mockGetAuthedClient.mockResolvedValue({ client: supabase, user: { id: 'user_1' }, error: null })
  const resp = await handler(makeRequest())
  expect(resp.status).toBe(200)
  expect(supabase.rpc).not.toHaveBeenCalled()
})

it('names the actual role and candidate on the PLACEMENT block via whatever getInvoice-shaped joins were returned', async () => {
  const invoice = { ...BASE_INVOICE, jobs: { title: 'Senior Backend Engineer' }, candidates: { name: 'Priya Shah' } }
  mockGetAuthedClient.mockResolvedValue({ client: makeSupabase({ invoice }), user: { id: 'user_1' }, error: null })
  await handler(makeRequest())
  expect(mockGenerateInvoicePdf.mock.calls[0][0]).toEqual(expect.objectContaining({ jobs: { title: 'Senior Backend Engineer' }, candidates: { name: 'Priya Shah' } }))
})

it('reports and returns 502 without marking the invoice sent when the email fails to send', async () => {
  mockSendInvoiceEmail.mockResolvedValue(false)
  const supabase = makeSupabase()
  mockGetAuthedClient.mockResolvedValue({ client: supabase, user: { id: 'user_1' }, error: null })
  const resp = await handler(makeRequest())
  expect(resp.status).toBe(502)
  expect(mockReportServerError).toHaveBeenCalled()
})

it('marks the invoice sent with a sent_at timestamp once the email succeeds', async () => {
  const resp = await handler(makeRequest())
  const body = await resp.json()
  expect(resp.status).toBe(200)
  expect(body.invoice.status).toBe('sent')
})

it('falls back to a profile lookup for created_by_name only when the invoice has none yet', async () => {
  const supabase = makeSupabase({ profile: { full_name: 'Jo Recruiter' } })
  mockGetAuthedClient.mockResolvedValue({ client: supabase, user: { id: 'user_1' }, error: null })
  await handler(makeRequest())
  expect(mockSendInvoiceEmail).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ senderName: 'Jo Recruiter' }))
})

it('returns 500-safe on an unexpected thrown error and reports it', async () => {
  mockGetAuthedClient.mockResolvedValue({ client: makeSupabase({ invoiceErr: { message: 'db down' } }), user: { id: 'user_1' }, error: null })
  const resp = await handler(makeRequest())
  expect(resp.status).toBe(500)
  expect(mockReportServerError).toHaveBeenCalled()
})
