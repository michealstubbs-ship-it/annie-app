// Maps an onboarding target market (LOCATIONS in Onboarding.jsx step 4) to
// the currency code that market actually invoices/reports in. Single source
// of truth for "what currency should this account default to" — before
// this file existed, Pipeline.jsx had its own local copy of this same idea
// (mapping to a display symbol rather than a code), and several other
// screens (Overview.jsx's pipeline-value stat, Invoices.jsx's totals bar,
// InvoiceFormModal.jsx's new-invoice default, Settings.jsx's invoicing
// default) just hardcoded 'AED' instead — Annie's own home market, not
// necessarily the customer's. For a UK-first launch that's a real
// credibility problem: a UK account's very first invoice/dashboard number
// showing AED reads as "this product wasn't built for me."
//
// Codes match invoiceCalc.js's CURRENCY_OPTIONS exactly, so a caller can
// pass the result straight into formatMoney()/currencySymbol() with no
// further mapping. Deliberately not exhaustive ISO 4217 — same reasoning as
// CURRENCY_OPTIONS itself: only the real, supported markets, not a guess at
// every world currency.
export const MARKET_CURRENCY_CODE = {
  'United Kingdom': 'GBP',
  'UAE / GCC': 'AED',
  'United States': 'USD',
}

// GBP, not AED — Annie's original market is the UK, and silently defaulting
// an unconfigured/unrecognised account to the operator's own home currency
// was exactly the bug this file exists to fix.
export const DEFAULT_CURRENCY_CODE = 'GBP'

export function resolveMarketCurrencyCode(locations) {
  if (!Array.isArray(locations) || !locations.length) return DEFAULT_CURRENCY_CODE
  return MARKET_CURRENCY_CODE[locations[0]] || DEFAULT_CURRENCY_CODE
}
