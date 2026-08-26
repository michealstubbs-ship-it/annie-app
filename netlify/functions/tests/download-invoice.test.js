// download-invoice.js is the plain-GET counterpart to send-invoice.js — no
// email, just the PDF bytes back to the recruiter for preview/download, but
// through a bearer token carried as a query param instead of a header (see
// its own header comment for why a plain link navigation needs that). These
// tests cover: method/param validation, auth (both missing and invalid
// token), RLS-style not-found for a foreign invoice, and that a successful
// request returns the actual PDF bytes with the right content type.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGenerateInvoicePdf } = vi.hoisted(() => ({ mockGenerateInvoicePdf: vi.fn() }))
const { mockReportServerError } = vi.hoisted(() => ({ mockReportServerError: vi.fn().mockResolvedValue(undefined) }))
const { mockCreateClient } = vi.hoisted(() => ({ mockCreateClient: vi.fn() }))

vi.mock('../lib/invoicePdf.js', () => ({ generateInvoicePdf: mockGenerateInvoicePdf }))
vi.mock('../lib/reportError.js', () => ({ reportServerError: mockReportServerError }))
vi.mock('@supabase/supabase-js', () => ({ createClient: mockCreateClient }))

const INVOICE = { id: 'inv_1', invoice_number: 'INV-2026-0001', invoice_line_items: [{ description: 'Fee', amount: 15000 }] }

function makeSupabase({ authError = null, invoice = INVOICE, invoiceErr = null, details = {}, detailsErr = null } = {}) {
  const invoiceQuery = { select: () => invoiceQuery, eq: () => invoiceQuery, maybeSingle: () => Promise.resolve({ data: invoiceErr ? null : invoice, error: invoiceErr }) }
  const detailsQuery = { select: () => detailsQuery, maybeSingle: () => Promise.resolve({ data: detailsErr ? null : details, error: detailsErr }) }
  return {
    auth: { getUser: () => Promise.resolve(authError ? { data: null, error: authError } : { data: { user: { id: 'user_1' } }, error: null }) },
    from: (table) => (table === 'invoices' ? invoiceQuery : detailsQuery),
  }
}

function makeRequest(params) {
  const url = new URL('https://annie.example/api/download-invoice')
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v)
  return new Request(url.toString(), { method: 'GET' })
}

let handler

beforeEach(async () => {
  vi.clearAllMocks()
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co'
  process.env.VITE_SUPABASE_ANON_KEY = 'anon_x'

  mockGenerateInvoicePdf.mockResolvedValue(new Uint8Array([1, 2, 3]))
  mockCreateClient.mockReturnValue(makeSupabase())

  vi.resetModules()
  ;({ default: handler } = await import('../download-invoice.js'))
})

it('rejects a non-GET request', async () => {
  const resp = await handler(new Request('https://annie.example/api/download-invoice', { method: 'POST' }))
  expect(resp.status).toBe(405)
})

it('returns 400 when invoiceId or token is missing', async () => {
  expect((await handler(makeRequest({ token: 't' }))).status).toBe(400)
  expect((await handler(makeRequest({ invoiceId: 'inv_1' }))).status).toBe(400)
})

it('returns 401 when the token fails verification', async () => {
  mockCreateClient.mockReturnValue(makeSupabase({ authError: { message: 'invalid' } }))
  const resp = await handler(makeRequest({ invoiceId: 'inv_1', token: 'bad' }))
  expect(resp.status).toBe(401)
  expect(mockGenerateInvoicePdf).not.toHaveBeenCalled()
})

it('returns 404 for an invoice the caller cannot see (RLS-scoped not-found)', async () => {
  mockCreateClient.mockReturnValue(makeSupabase({ invoice: null }))
  const resp = await handler(makeRequest({ invoiceId: 'inv_1', token: 't' }))
  expect(resp.status).toBe(404)
})

it('returns the generated PDF bytes with the right content type and an inline filename from the invoice number', async () => {
  const resp = await handler(makeRequest({ invoiceId: 'inv_1', token: 't' }))
  expect(resp.status).toBe(200)
  expect(resp.headers.get('Content-Type')).toBe('application/pdf')
  expect(resp.headers.get('Content-Disposition')).toContain('INV-2026-0001.pdf')
  const body = new Uint8Array(await resp.arrayBuffer())
  expect(Array.from(body)).toEqual([1, 2, 3])
})

it('falls back to a generic filename for a draft with no invoice number yet', async () => {
  mockCreateClient.mockReturnValue(makeSupabase({ invoice: { ...INVOICE, invoice_number: null } }))
  const resp = await handler(makeRequest({ invoiceId: 'inv_1', token: 't' }))
  expect(resp.headers.get('Content-Disposition')).toContain('draft-invoice.pdf')
})

it('returns 500-safe on an unexpected thrown error and reports it', async () => {
  mockCreateClient.mockReturnValue(makeSupabase({ invoiceErr: { message: 'db down' } }))
  const resp = await handler(makeRequest({ invoiceId: 'inv_1', token: 't' }))
  expect(resp.status).toBe(500)
  expect(mockReportServerError).toHaveBeenCalled()
})
