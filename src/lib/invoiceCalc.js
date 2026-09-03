// Single source of truth for turning a set of invoice line items (plus a
// tax rate) into subtotal/tax/total — used by the invoice creation form
// (to show a live total as line items are edited) AND by the PDF generator
// (netlify/functions/lib/invoicePdf.js), so the number a customer sees on
// screen before sending is guaranteed to be the exact same number that
// ends up printed on the document, computed by the same code rather than
// two independent implementations that could drift.
//
// Money is handled in whole cents internally to avoid floating-point drift
// (0.1 + 0.2 !== 0.3) accumulating across several line items — every
// public function here takes/returns plain decimal amounts (e.g. 1250.5),
// converting to/from integer cents only inside this file.

function toCents(amount) {
  return Math.round((Number(amount) || 0) * 100)
}

function fromCents(cents) {
  return Math.round(cents) / 100
}

// A single line item's amount, from quantity * unit price — kept as its
// own function since the form recomputes this per-row as the customer
// types, before the whole-invoice totals below are computed from it.
export function lineItemAmount(quantity, unitAmount) {
  const qtyCents = Math.round((Number(quantity) || 0) * 100)
  const unitCents = toCents(unitAmount)
  // Both operands already scaled by 100 ("cents"), so their raw product is
  // scaled by 100*100 — divide back down once, rounding, before converting
  // the result back to a decimal amount.
  return fromCents(Math.round((qtyCents * unitCents) / 100))
}

// lineItems: array of { amount } (or anything with a numeric `amount`
// field — line items from the DB and from the in-progress form both shape
// this way). taxRatePercent: e.g. 5 for 5%, 0/null/undefined for no tax.
export function computeInvoiceTotals(lineItems, taxRatePercent) {
  const subtotalCents = (lineItems || []).reduce((sum, li) => sum + toCents(li.amount), 0)
  const rate = Number(taxRatePercent) || 0
  // Tax computed once on the whole subtotal, not summed per-line — avoids
  // rounding a few extra cents into existence across several small lines.
  const taxCents = Math.round(subtotalCents * (rate / 100))
  return {
    subtotal: fromCents(subtotalCents),
    taxAmount: fromCents(taxCents),
    total: fromCents(subtotalCents + taxCents),
  }
}

// The currency codes Annie's own product actually deals in — Jobs.jsx
// displays placement fees in AED today, pricing.js/Stripe bill
// subscriptions in USD, and SupportWidget.jsx's onboarding section
// confirms UK/UAE-GCC/US as the three real, supported markets. Not an
// exhaustive ISO 4217 list — just what this product's real customers need,
// with GBP/EUR covering an invoice in a currency Annie has no other use
// for yet. Anything more exotic should come from a direct request rather
// than guessing at every world currency up front.
// 2026-09-04, Michael (candidate salary currency question, "1 and 2" —
// both match the existing list AND add the full GCC set): the live_job
// sourcing side of the product already covers every GCC market (AE, SA,
// QA, KW, BH, OM — see THEIRSTACK_COUNTRY_MAP in scanShared.js), but this
// list only ever covered 2 of those 6 (AED, SAR). Rounded it out to match,
// since a candidate's salary is just as likely to be quoted in QAR/KWD/
// BHD/OMR as AED/SAR for a firm actually working those markets, same
// reasoning as AED/SAR being here at all.
export const CURRENCY_OPTIONS = [
  { code: 'AED', symbol: 'AED', label: 'UAE Dirham (AED)' },
  { code: 'GBP', symbol: '£', label: 'British Pound (GBP)' },
  { code: 'USD', symbol: '$', label: 'US Dollar (USD)' },
  { code: 'EUR', symbol: '€', label: 'Euro (EUR)' },
  { code: 'SAR', symbol: 'SAR', label: 'Saudi Riyal (SAR)' },
  { code: 'QAR', symbol: 'QAR', label: 'Qatari Riyal (QAR)' },
  { code: 'KWD', symbol: 'KWD', label: 'Kuwaiti Dinar (KWD)' },
  { code: 'BHD', symbol: 'BHD', label: 'Bahraini Dinar (BHD)' },
  { code: 'OMR', symbol: 'OMR', label: 'Omani Rial (OMR)' },
]

export function currencySymbol(code) {
  return CURRENCY_OPTIONS.find(c => c.code === code)?.symbol || code || ''
}

// 2026-08-29 audit fix: this always inserted a space between symbol and
// amount ("AED 54,600.00", correct for a 3-letter code) — but every other
// currency here (£, $, €) is a single-character symbol that reads correctly
// with NO space ("£54,600.00", the normal convention), so every non-AED
// invoice showed an oddly-spaced "£ 54,600.00". One formatter written for
// AED and never adjusted when GBP/USD/EUR/SAR were added to CURRENCY_OPTIONS
// — the space is conditional on symbol length now, same rule Pipeline.jsx's
// own (separate, pre-existing) currency-prefix display already used, so the
// two finally agree instead of drifting.
export function formatMoney(amount, currencyCode) {
  const symbol = currencySymbol(currencyCode)
  const n = Number(amount) || 0
  const formatted = n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return symbol.length > 1 ? `${symbol} ${formatted}` : `${symbol}${formatted}`
}

// 2026-09-03, Michael ("rebate/guarantee period tracking" — one of the two
// oversights he asked to be prioritized): a pure day-math function, same
// reasoning as the rest of this file — the invoice list badge, the invoice
// detail view, and any future reminder/notification all need the exact
// same "is this still inside the window" answer, computed once here
// rather than three places quietly drifting on how they count days.
//
// `invoice` only needs guarantee_starts_at/guarantee_days/rebate_triggered_at
// — callers pass the whole invoice row for convenience, nothing else here
// reads other fields. `today` is injectable (defaults to `new Date()`) so
// tests don't depend on the real clock.
export function getGuaranteeStatus(invoice, today = new Date()) {
  if (invoice?.rebate_triggered_at) {
    return { state: 'triggered', daysLeft: null, daysElapsed: null }
  }
  if (!invoice?.guarantee_starts_at) {
    return { state: 'not_started', daysLeft: null, daysElapsed: null }
  }
  const start = new Date(invoice.guarantee_starts_at)
  const guaranteeDays = Number(invoice.guarantee_days) || 90
  const msPerDay = 24 * 60 * 60 * 1000
  const daysElapsed = Math.floor((today.getTime() - start.getTime()) / msPerDay)
  const daysLeft = guaranteeDays - daysElapsed
  if (daysLeft <= 0) return { state: 'expired', daysLeft: 0, daysElapsed }
  if (daysLeft <= 14) return { state: 'ending_soon', daysLeft, daysElapsed }
  return { state: 'active', daysLeft, daysElapsed }
}

// Plain-language label for the badge — kept separate from the state
// machine above so a future locale/wording change doesn't touch the
// actual day-math, same split as currencySymbol()/formatMoney() above.
export function guaranteeStatusLabel(status) {
  switch (status.state) {
    case 'triggered': return 'Rebate/replacement triggered'
    case 'not_started': return 'Guarantee not started'
    case 'expired': return 'Guarantee period ended'
    case 'ending_soon': return `Guarantee ends in ${status.daysLeft} day${status.daysLeft === 1 ? '' : 's'}`
    default: return `${status.daysLeft} days left on guarantee`
  }
}
