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

// 2026-09-06, Michael: "make sure it is only specifically shown for
// recruiters in UAE and not UK" — the gap-analysis batch 1-3 GCC-specific
// fields (visa/sponsorship tracking, Emiratization/Saudization quota,
// WPS-aware invoicing, Ramadan-aware pipeline aging) were built with no
// market gating at all, so every account saw them regardless of which
// market(s) they ticked in onboarding. This is the fix: unlike
// resolveMarketCurrencyCode above (which only looks at locations[0] — a
// single default currency has to pick one), this checks the WHOLE
// locations array, since a firm that ticked BOTH "United Kingdom" and
// "UAE / GCC" genuinely does need the GCC fields, even though their
// default currency resolves to GBP.
export function isGccMarket(locations) {
  return Array.isArray(locations) && locations.includes('UAE / GCC')
}
