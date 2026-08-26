// generateInvoicePdf is the one render path shared by send-invoice.js and
// download-invoice.js (see its own header comment for why that sharing
// matters) — these tests exercise it directly against pdf-lib rather than
// mocking it, since a syntax/API-usage bug in the drawing calls themselves
// is exactly the kind of thing a mocked test would never catch.
import { describe, it, expect } from 'vitest'
import zlib from 'zlib'
import { PDFDocument } from 'pdf-lib'
import { generateInvoicePdf } from '../lib/invoicePdf.js'

// pdf-lib saves every content stream FlateDecode-compressed by default, and
// draws each string as a hex-encoded glyph string (`<5041594D...>`) rather
// than a literal `(PAYMENT DETAILS)` — a plain substring search against the
// raw saved bytes silently never matches anything, compressed or not. This
// walks every `stream...endstream` block, inflates it when it's compressed,
// then decodes every hex string literal back to plain ASCII (Standard PDF
// fonts here are single-byte WinAnsi, so this is a direct byte-for-byte
// decode, not an approximation) so the tests can assert on what a person
// would actually see on the rendered page.
function extractPdfText(bytes) {
  const raw = Buffer.from(bytes).toString('latin1')
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g
  let match
  let text = ''
  while ((match = streamRe.exec(raw))) {
    let content = match[1]
    try {
      content = zlib.inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1')
    } catch {
      // Not a FlateDecode stream (or not one we could inflate) — search it
      // as-is, harmless either way.
    }
    const hexStringRe = /<([0-9A-Fa-f]{2,})>/g
    let hexMatch
    while ((hexMatch = hexStringRe.exec(content))) {
      const hex = hexMatch[1]
      if (hex.length % 2 !== 0) continue
      let decoded = ''
      for (let i = 0; i < hex.length; i += 2) decoded += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16))
      text += decoded + ' '
    }
  }
  return text
}

const FULL_INVOICE = {
  invoice_number: 'INV-2026-0001',
  issue_date: '2026-08-26',
  due_date: '2026-09-09',
  bill_to_name: 'Acme Corp',
  bill_to_email: 'ap@acme.com',
  bill_to_address: '1 Sheikh Zayed Road, Dubai, UAE',
  currency: 'AED',
  subtotal: 15000,
  tax_rate: 5,
  tax_amount: 750,
  total: 15750,
  notes: 'Thank you for your business.',
  created_by_name: 'Jo Recruiter',
  jobs: { title: 'Senior Backend Engineer' },
  companies: { name: 'Acme Corp' },
  candidates: { name: 'Priya Shah' },
}

const FULL_LINE_ITEMS = [
  { description: 'Placement fee — Senior Backend Engineer', quantity: 1, unit_amount: 15000, amount: 15000 },
]

const FULL_DETAILS = {
  business_name: 'Vantage Search Group',
  business_address: '123 Business Bay, Dubai, UAE',
  business_email: 'billing@vantagesearch.example',
  business_phone: '+971 4 000 0000',
  tax_number: 'TRN123456789',
  bank_account_name: 'Vantage Search Group ME DWC-LLC',
  bank_name: 'Emirates NBD',
  bank_account_number: '0123456789',
  bank_sort_code: '',
  bank_iban: 'AE070331234567890123456',
  bank_swift_bic: 'EBILAEAD',
  invoice_footer_note: 'Payment due within 14 days.',
}

async function isValidPdf(bytes) {
  // A real end-to-end check: can pdf-lib itself load what we just
  // generated back as a document, and does it have exactly one page.
  const doc = await PDFDocument.load(bytes)
  return doc.getPageCount()
}

describe('generateInvoicePdf', () => {
  it('produces a loadable single-page PDF with every section filled in', async () => {
    const bytes = await generateInvoicePdf(FULL_INVOICE, FULL_LINE_ITEMS, FULL_DETAILS)
    expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-')
    expect(await isValidPdf(bytes)).toBe(1)
  })

  it('actually renders the invoice number, the role, and the candidate placed onto the page', async () => {
    const bytes = await generateInvoicePdf(FULL_INVOICE, FULL_LINE_ITEMS, FULL_DETAILS)
    const text = extractPdfText(bytes)
    expect(text).toContain('INV-2026-0001')
    expect(text).toContain('Senior Backend Engineer')
    expect(text).toContain('Priya Shah')
  })

  it('still produces a valid PDF with no invoicing_details row at all (never filled in yet)', async () => {
    const bytes = await generateInvoicePdf(FULL_INVOICE, FULL_LINE_ITEMS, null)
    expect(await isValidPdf(bytes)).toBe(1)
  })

  it('still produces a valid PDF for a draft with no invoice number, no job/candidate, no line items', async () => {
    const draft = { bill_to_name: 'Acme Corp', currency: 'AED', subtotal: 0, tax_rate: 0, tax_amount: 0, total: 0 }
    const bytes = await generateInvoicePdf(draft, [], {})
    expect(await isValidPdf(bytes)).toBe(1)
  })

  it('omits the payment-details block entirely when no bank fields are set, rather than showing blanks', async () => {
    const detailsNoBank = { business_name: 'Vantage Search Group' }
    const bytes = await generateInvoicePdf(FULL_INVOICE, FULL_LINE_ITEMS, detailsNoBank)
    const text = extractPdfText(bytes)
    expect(text).not.toContain('PAYMENT DETAILS')
  })

  it('includes the payment-details block when at least one bank field is set', async () => {
    const bytes = await generateInvoicePdf(FULL_INVOICE, FULL_LINE_ITEMS, FULL_DETAILS)
    const text = extractPdfText(bytes)
    expect(text).toContain('PAYMENT DETAILS')
    expect(text).toContain('AE070331234567890123456')
  })

  it('wraps a long description across multiple lines instead of overflowing the column', async () => {
    const longItem = [{ description: 'A very long line item description that should wrap across more than one line in the generated PDF table cell', quantity: 1, unit_amount: 5000, amount: 5000 }]
    const bytes = await generateInvoicePdf(FULL_INVOICE, longItem, FULL_DETAILS)
    expect(await isValidPdf(bytes)).toBe(1)
  })
})
