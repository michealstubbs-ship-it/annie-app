// Renders a real, professional invoice PDF from an invoice record — used
// by both send-invoice.js (attaches it to the email out to the client) and
// download-invoice.js (a direct download for the recruiter). One shared
// generator so the PDF a recruiter downloads to check is always byte-for-
// byte the same document their client actually receives by email, rather
// than two render paths that could quietly drift apart.
//
// Built with pdf-lib (no headless browser, no native binary — a real
// concern in a Netlify Function's small, ephemeral runtime) drawing text
// directly onto an A4 page. Deliberately not templated off an HTML/CSS
// renderer: pdf-lib gives byte-exact control over a fairly simple, fixed
// layout, which an invoice is.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

const NAVY = rgb(0.051, 0.106, 0.243) // #0d1b3e, Annie's own brand navy
const GOLD = rgb(0.788, 0.659, 0.298) // #c9a84c
const GREY = rgb(0.42, 0.45, 0.5)
const LIGHT_GREY = rgb(0.9, 0.91, 0.93)
const BLACK = rgb(0.1, 0.1, 0.12)

const PAGE_WIDTH = 595.28 // A4 at 72dpi
const PAGE_HEIGHT = 841.89
const MARGIN = 50

function money(amount, currency) {
  const n = Number(amount) || 0
  return `${currency || ''} ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.trim()
}

function formatDate(d) {
  if (!d) return ''
  const dt = new Date(d)
  if (isNaN(dt.getTime())) return String(d)
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

// Splits a long line of text into several lines that fit within
// maxWidth, using the given font/size — pdf-lib has no built-in text
// wrapping, every caller drawing a paragraph-length field (address,
// notes) needs this.
function wrapText(text, font, size, maxWidth) {
  const words = String(text || '').split(/\s+/).filter(Boolean)
  const lines = []
  let current = ''
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && current) {
      lines.push(current)
      current = word
    } else {
      current = candidate
    }
  }
  if (current) lines.push(current)
  return lines
}

// invoice: the full row from invoices (+ joined companies/jobs/candidates
// names) as returned by getInvoice() in src/lib/data/invoices.js.
// lineItems: invoice_line_items rows. details: the team's invoicing_details
// row (may be null/mostly-empty if the recruiter never filled it in — the
// PDF still renders correctly with sparse/no bank details, it just omits
// fields that aren't set rather than showing blanks or placeholder text).
export async function generateInvoicePdf(invoice, lineItems, details) {
  const pdf = await PDFDocument.create()
  let page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  const pages = [page]
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)

  let y = PAGE_HEIGHT - MARGIN

  // 2026-08-27 audit fix: this used to be a single fixed A4 page with no
  // overflow handling at all — a long bill-to address, enough line items,
  // a long notes field, or a full bank-details block could push content
  // below y=0 (invisible once printed/viewed) or straight through the
  // fixed-position footer at y=30, silently dropping whatever came last —
  // most likely the bank-details block a client actually needs to pay the
  // invoice. FOOTER_BAND reserves room above the footer on every page;
  // ensureSpace starts a fresh page rather than letting anything overrun
  // that band. The footer itself is now drawn on every page (not just
  // whichever page happened to be last), each carrying a page number once
  // there's more than one.
  const FOOTER_BAND = 50
  const MIN_Y = MARGIN + FOOTER_BAND

  function addPage() {
    page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT])
    pages.push(page)
    y = PAGE_HEIGHT - MARGIN
    return page
  }

  function ensureSpace(neededHeight) {
    if (y - neededHeight < MIN_Y) addPage()
  }

  function drawTableHeaderRow() {
    const tableTop = y
    page.drawRectangle({ x: MARGIN, y: tableTop - 18, width: PAGE_WIDTH - MARGIN * 2, height: 18, color: NAVY })
    page.drawText('DESCRIPTION', { x: col.desc + 6, y: tableTop - 13, size: 8, font: bold, color: rgb(1, 1, 1) })
    page.drawText('QTY', { x: col.qty, y: tableTop - 13, size: 8, font: bold, color: rgb(1, 1, 1) })
    page.drawText('UNIT', { x: col.unit, y: tableTop - 13, size: 8, font: bold, color: rgb(1, 1, 1) })
    page.drawText('AMOUNT', { x: col.amount, y: tableTop - 13, size: 8, font: bold, color: rgb(1, 1, 1) })
    y = tableTop - 18
  }

  // --- Header: firm name/address (left) + INVOICE title/number (right) ---
  const businessName = details?.business_name || 'Your Business'
  page.drawText(businessName, { x: MARGIN, y, size: 16, font: bold, color: NAVY })
  page.drawText('INVOICE', { x: PAGE_WIDTH - MARGIN - bold.widthOfTextAtSize('INVOICE', 20), y, size: 20, font: bold, color: NAVY })
  y -= 20

  const addressLines = details?.business_address ? wrapText(details.business_address, font, 9, 220) : []
  for (const line of addressLines) {
    page.drawText(line, { x: MARGIN, y, size: 9, font, color: GREY })
    y -= 12
  }
  if (details?.business_email) { page.drawText(details.business_email, { x: MARGIN, y, size: 9, font, color: GREY }); y -= 12 }
  if (details?.business_phone) { page.drawText(details.business_phone, { x: MARGIN, y, size: 9, font, color: GREY }); y -= 12 }
  if (details?.tax_number) { page.drawText(`Tax/VAT No: ${details.tax_number}`, { x: MARGIN, y, size: 9, font, color: GREY }); y -= 12 }

  const invoiceNumberText = invoice.invoice_number || '(draft — no number assigned yet)'
  page.drawText(invoiceNumberText, { x: PAGE_WIDTH - MARGIN - font.widthOfTextAtSize(invoiceNumberText, 11), y: PAGE_HEIGHT - MARGIN - 24, size: 11, font: bold, color: BLACK })
  page.drawText(`Issue date: ${formatDate(invoice.issue_date)}`, { x: PAGE_WIDTH - MARGIN - font.widthOfTextAtSize(`Issue date: ${formatDate(invoice.issue_date)}`, 9), y: PAGE_HEIGHT - MARGIN - 40, size: 9, font, color: GREY })
  if (invoice.due_date) {
    const dueText = `Due date: ${formatDate(invoice.due_date)}`
    page.drawText(dueText, { x: PAGE_WIDTH - MARGIN - font.widthOfTextAtSize(dueText, 9), y: PAGE_HEIGHT - MARGIN - 52, size: 9, font, color: GREY })
  }

  y -= 24
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y }, thickness: 1, color: LIGHT_GREY })
  y -= 24

  // --- Bill to ---
  page.drawText('BILL TO', { x: MARGIN, y, size: 9, font: bold, color: GOLD })
  y -= 14
  page.drawText(invoice.bill_to_name || '', { x: MARGIN, y, size: 11, font: bold, color: BLACK })
  y -= 14
  if (invoice.bill_to_address) {
    for (const line of wrapText(invoice.bill_to_address, font, 9, 250)) {
      page.drawText(line, { x: MARGIN, y, size: 9, font, color: GREY })
      y -= 12
    }
  }
  if (invoice.bill_to_email) { page.drawText(invoice.bill_to_email, { x: MARGIN, y, size: 9, font, color: GREY }); y -= 12 }

  // --- What this invoice is for: role + candidate placed, if attached ---
  // This is the whole reason a placement-fee invoice reads as legitimate
  // rather than a bare dollar amount — naming the actual role and the
  // actual person placed into it, not just "recruitment services."
  const jobTitle = invoice.jobs?.title
  const companyName = invoice.companies?.name
  const candidateName = invoice.candidates?.name
  if (jobTitle || candidateName) {
    ensureSpace(38)
    y -= 10
    page.drawText('PLACEMENT', { x: MARGIN, y, size: 9, font: bold, color: GOLD })
    y -= 14
    const parts = []
    if (jobTitle) parts.push(`Role: ${jobTitle}${companyName ? ` at ${companyName}` : ''}`)
    if (candidateName) parts.push(`Candidate placed: ${candidateName}`)
    for (const line of parts) {
      ensureSpace(14)
      page.drawText(line, { x: MARGIN, y, size: 10, font, color: BLACK })
      y -= 14
    }
  }

  y -= 16

  // --- Line items table ---
  const col = { desc: MARGIN, qty: 330, unit: 390, amount: 470 }
  ensureSpace(18)
  drawTableHeaderRow()

  const currency = invoice.currency || ''
  for (const li of lineItems || []) {
    const descLines = wrapText(li.description, font, 10, col.qty - col.desc - 12)
    const rowHeight = Math.max(20, descLines.length * 12 + 6)
    // 2026-08-27 audit fix: a long invoice (many line items) used to just
    // keep drawing rows past the bottom of the one fixed page — invisible
    // once y went negative. Starting a fresh page (and repeating the
    // column header, so a reader landing on page 2 alone still knows what
    // each column means) keeps every row visible regardless of how many
    // there are.
    if (y - rowHeight < MIN_Y) {
      addPage()
      drawTableHeaderRow()
    }
    y -= rowHeight
    page.drawLine({ start: { x: MARGIN, y: y + rowHeight }, end: { x: PAGE_WIDTH - MARGIN, y: y + rowHeight }, thickness: 0.5, color: LIGHT_GREY })
    let lineY = y + rowHeight - 12
    for (const line of descLines) {
      page.drawText(line, { x: col.desc + 6, y: lineY, size: 10, font, color: BLACK })
      lineY -= 12
    }
    page.drawText(String(li.quantity ?? 1), { x: col.qty, y: y + rowHeight - 12, size: 10, font, color: BLACK })
    page.drawText(money(li.unit_amount, currency), { x: col.unit, y: y + rowHeight - 12, size: 10, font, color: BLACK })
    const amtText = money(li.amount, currency)
    page.drawText(amtText, { x: PAGE_WIDTH - MARGIN - 6 - font.widthOfTextAtSize(amtText, 10), y: y + rowHeight - 12, size: 10, font, color: BLACK })
  }
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y }, thickness: 1, color: LIGHT_GREY })

  // --- Totals ---
  // Kept together as one block (ensureSpace checked once, up front, for the
  // full block's height) rather than letting the divider line or TOTAL DUE
  // row land alone at the top of a fresh page, split from Subtotal/Tax
  // above it.
  ensureSpace(20 + 16 + 16 + 6 + 16)
  y -= 20
  // 290, not 400: at 400 the bold 13pt "TOTAL DUE" label and a real
  // (4-5 digit) total's value literally overlapped on the page — the two
  // widths (label + value) can exceed the ~140pt a 400 start leaves before
  // the right margin. 290 leaves ~250pt, comfortably fitting both even for
  // a 7-figure total, confirmed by rendering a sample invoice to an image
  // and inspecting it directly rather than just checking the PDF builds.
  const totalsX = 290
  const drawTotalRow = (label, value, opts = {}) => {
    page.drawText(label, { x: totalsX, y, size: opts.size || 10, font: opts.font || font, color: opts.color || GREY })
    const valText = money(value, currency)
    page.drawText(valText, { x: PAGE_WIDTH - MARGIN - 6 - (opts.font || font).widthOfTextAtSize(valText, opts.size || 10), y, size: opts.size || 10, font: opts.font || font, color: opts.color || BLACK })
    y -= 16
  }
  drawTotalRow('Subtotal', invoice.subtotal)
  if (Number(invoice.tax_rate) > 0) drawTotalRow(`Tax (${invoice.tax_rate}%)`, invoice.tax_amount)
  page.drawLine({ start: { x: totalsX, y: y + 6 }, end: { x: PAGE_WIDTH - MARGIN, y: y + 6 }, thickness: 1, color: NAVY })
  y -= 6
  drawTotalRow('TOTAL DUE', invoice.total, { size: 13, font: bold, color: NAVY })

  // --- Bank details (payment instructions) ---
  y -= 24
  const hasBankDetails = details?.bank_account_name || details?.bank_account_number || details?.bank_iban
  if (hasBankDetails) {
    const bankLines = [
      details.bank_account_name ? `Account name: ${details.bank_account_name}` : null,
      details.bank_name ? `Bank: ${details.bank_name}` : null,
      details.bank_account_number ? `Account number: ${details.bank_account_number}` : null,
      details.bank_sort_code ? `Sort code: ${details.bank_sort_code}` : null,
      details.bank_iban ? `IBAN: ${details.bank_iban}` : null,
      details.bank_swift_bic ? `SWIFT/BIC: ${details.bank_swift_bic}` : null,
    ].filter(Boolean)
    // Heading kept with at least its first line, rather than a bare
    // "PAYMENT DETAILS" label stranded alone at the bottom of a page with
    // every actual bank field pushed onto the next one.
    ensureSpace(14 + 12)
    page.drawText('PAYMENT DETAILS', { x: MARGIN, y, size: 9, font: bold, color: GOLD })
    y -= 14
    for (const line of bankLines) {
      ensureSpace(12)
      page.drawText(line, { x: MARGIN, y, size: 9, font, color: BLACK })
      y -= 12
    }
  }

  // --- Notes / footer note ---
  const noteText = invoice.notes || details?.invoice_footer_note
  if (noteText) {
    y -= 16
    for (const line of wrapText(noteText, font, 9, PAGE_WIDTH - MARGIN * 2)) {
      ensureSpace(12)
      page.drawText(line, { x: MARGIN, y, size: 9, font, color: GREY })
      y -= 12
    }
  }

  // Page footer — always at a fixed position on every page, not flowing
  // with content, so it never collides with a long invoice's own content
  // above. Drawn on every page now (2026-08-27 audit fix — a multi-page
  // invoice used to only ever get one page in the first place, so this
  // ran once by construction; now that content can genuinely span more
  // than one page, each page needs its own footer, and a page number once
  // there's more than one so a reader can tell it's not the whole invoice).
  const footerLeft = invoice.created_by_name ? `Prepared by ${invoice.created_by_name} · ${businessName}` : `Generated by Annie · ${businessName}`
  pages.forEach((p, i) => {
    p.drawText(footerLeft, { x: MARGIN, y: 30, size: 8, font, color: LIGHT_GREY })
    if (pages.length > 1) {
      const pageText = `Page ${i + 1} of ${pages.length}`
      p.drawText(pageText, { x: PAGE_WIDTH - MARGIN - font.widthOfTextAtSize(pageText, 8), y: 30, size: 8, font, color: LIGHT_GREY })
    }
  })

  return pdf.save()
}
