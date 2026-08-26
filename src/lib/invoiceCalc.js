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
export const CURRENCY_OPTIONS = [
  { code: 'AED', symbol: 'AED', label: 'UAE Dirham (AED)' },
  { code: 'GBP', symbol: '£', label: 'British Pound (GBP)' },
  { code: 'USD', symbol: '$', label: 'US Dollar (USD)' },
  { code: 'EUR', symbol: '€', label: 'Euro (EUR)' },
  { code: 'SAR', symbol: 'SAR', label: 'Saudi Riyal (SAR)' },
]

export function currencySymbol(code) {
  return CURRENCY_OPTIONS.find(c => c.code === code)?.symbol || code || ''
}

export function formatMoney(amount, currencyCode) {
  const symbol = currencySymbol(currencyCode)
  const n = Number(amount) || 0
  return `${symbol} ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
