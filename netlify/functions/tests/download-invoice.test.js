// download-invoice.js is the plain-GET counterpart to send-invoice.js — no
// email, just the PDF bytes back to the recruiter for preview/download,
// authenticated the same Authorization-header way as every other function
// (getAuthedClient) since the 2026-08-27 audit fix (it used to carry the
// caller's real session token as a `?token=` query param instead — see the
// file's own header comment for why that leaked a replayable bearer
// credential into URLs). These tests cover: method/param validation, auth
// (both missing and invalid), RLS-style not-found for a foreign invoice, and
// that a successful request returns the actual PDF bytes with the right
// content type.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetAuthedClient } = vi.hoisted(() => ({ mockGetAuthedClient: vi.fn() }))
const { mockGenerateInvoicePdf } = vi.hoisted(() => ({ mockGenerateInvoicePdf: vi.fn() }))
const { mockReportServerError } = vi.hoisted(() => ({ mockReportServerError: vi.fn().mockResolvedValue(undefined) }))

vi.mock('../lib/auth.js', () => ({ getAuthedClient: mockGetAuthedClient }))
vi.mock('../lib/invoicePdf.js', () => ({ generateInvoicePdf: mockGenerateInvoicePdf }))
vi.mock('../lib/reportError.js', () => ({ reportServerError: mockReportServerError }))

const INVOICE = { id: 'inv_1', invoice_number: 'INV-2026-0001', invoice_line_items: [{ description: 'Fee', amount: 15000 }] }

function makeSupabase({ invoice = INVOICE, invoiceErr = null, details = {}, detailsErr = null } = {}) {
  const invoiceQuery = { select: () => invoiceQuery, eq: () => invoiceQuery, maybeSingle: () => Promise.resolve({ data: invoiceErr ? null : invoice, error: invoiceErr }) }
  const detailsQuery = { select: () => detailsQuery, maybeSingle: () => Promise.resolve({ data: detailsErr ? null : details, error: detailsErr }) }
  return { from: (table) => (table === 'invoices' ? invoiceQuery : detailsQuery) }
}

function makeRequest(params, { auth = true } = {}) {
  const url = new URL('https://annie.example/api/download-invoice')
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v)
  const headers = auth ? { Authorization: 'Bearer test-token' } : {}
  return new Request(url.toString(), { method: 'GET', headers })
}

let handler

beforeEach(async () => {
  vi.clearAllMocks()
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co'
  process.env.VITE_SUPABASE_ANON_KEY = 'anon_x'

  mockGenerateInvoicePdf.mockResolvedValue(new Uint8Array([1, 2, 3]))
  mockGetAuthedClient.mockResolvedValue({ client: makeSupabase(), user: { id: 'user_1' }, error: null })

  vi.resetModules()
  ;({ default: handler } = await import('../download-invoice.js'))
})

it('rejects a non-GET request', async () => {
  const resp = await handler(new Request('https://annie.example/api/download-invoice', { method: 'POST' }))
  expect(resp.status).toBe(405)
})

it('returns 400 when invoiceId is missing', async () => {
  const resp = await handler(makeRequest({}))
  expect(resp.status).toBe(400)
})

it('returns 401 when there is no Authorization header, without ever touching the database', async () => {
  mockGetAuthedClient.mockResolvedValue({ client: null, user: null, error: 'missing_token' })
  const resp = await handler(makeRequest({ invoiceId: 'inv_1' }, { auth: false }))
  expect(resp.status).toBe(401)
  expect(mockGenerateInvoicePdf).not.toHaveBeenCalled()
})

it('returns 401 when the token fails verification', async () => {
  mockGetAuthedClient.mockResolvedValue({ client: null, user: null, error: 'invalid_session' })
  const resp = await handler(makeRequest({ invoiceId: 'inv_1' }))
  expect(resp.status).toBe(401)
  expect(mockGenerateInvoicePdf).not.toHaveBeenCalled()
})

it('returns 404 for an invoice the caller cannot see (RLS-scoped not-found)', async () => {
  mockGetAuthedClient.mockResolvedValue({ client: makeSupabase({ invoice: null }), user: { id: 'user_1' }, error: null })
  const resp = await handler(makeRequest({ invoiceId: 'inv_1' }))
  expect(resp.status).toBe(404)
})

it('returns the generated PDF bytes with the right content type and an inline filename from the invoice number', async () => {
  const resp = await handler(makeRequest({ invoiceId: 'inv_1' }))
  expect(resp.status).toBe(200)
  expect(resp.headers.get('Content-Type')).toBe('application/pdf')
  expect(resp.headers.get('Content-Disposition')).toContain('INV-2026-0001.pdf')
  const body = new Uint8Array(await resp.arrayBuffer())
  expect(Array.from(body)).toEqual([1, 2, 3])
})

it('falls back to a generic filename for a draft with no invoice number yet', async () => {
  mockGetAuthedClient.mockResolvedValue({ client: makeSupabase({ invoice: { ...INVOICE, invoice_number: null } }), user: { id: 'user_1' }, error: null })
  const resp = await handler(makeRequest({ invoiceId: 'inv_1' }))
  expect(resp.headers.get('Content-Disposition')).toContain('draft-invoice.pdf')
})

it('returns 500-safe on an unexpected thrown error and reports it', async () => {
  mockGetAuthedClient.mockResolvedValue({ client: makeSupabase({ invoiceErr: { message: 'db down' } }), user: { id: 'user_1' }, error: null })
  const resp = await handler(makeRequest({ invoiceId: 'inv_1' }))
  expect(resp.status).toBe(500)
  expect(mockReportServerError).toHaveBeenCalled()
})
