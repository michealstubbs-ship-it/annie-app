import { useState, useEffect, useMemo } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from './supabase'
import { resolveMarketCurrencyCode, DEFAULT_CURRENCY_CODE } from './marketCurrency'
import { currencySymbol } from './invoiceCalc'
import { getInvoicingDetails } from './data/invoicingDetails'

// 2026-08-30: the 2026-08-29 currency audit fixed Overview, Invoices,
// InvoiceFormModal and Settings but missed Candidates, Jobs and
// JobFormModal, which still hardcoded 'AED' — Annie's own home market, not
// the customer's. For a UK-first launch a GBP-priced product showing a
// candidate's desired salary as "AED 300,000" is a credibility problem, not
// a cosmetic one.
//
// The four already-fixed screens each hand-rolled the same
// onboarding-fetch + resolve + symbol-prefix logic (Overview.jsx:305 and
// :369, Invoices.jsx:48). Rather than add three more copies of it and give
// this bug a sixth place to drift, that shape lives here once. Same
// reasoning marketCurrency.js itself was extracted for.
//
// currencyPrefix follows the convention Overview.jsx and Pipeline.jsx
// already settled on for whole-number amounts: a space after a multi-letter
// code ("AED 300,000") and none after a single-character symbol
// ("£300,000"). currencyLabel is the bare symbol for use inside a form
// label's parentheses, where a trailing space reads wrong ("Salary (AED )").
//
// Deliberately NOT routed through formatMoney(): that forces two decimal
// places for invoice-line precision, which is wrong for a salary or a fee
// headline. currencySymbol() is still the one shared source for the symbol
// itself, so this can't drift from invoiceCalc.js's currency list.
//
// 2026-08-31 audit fix: a firm working more than one onboarding market
// (e.g. both "United Kingdom" and "UAE / GCC" ticked) used to get whichever
// one happened to be first in the array they clicked during onboarding —
// order-dependent, not a deliberate choice. Settings -> Invoicing already
// has a real "Default currency" picker (invoicing_details.default_currency,
// any of CURRENCY_OPTIONS — not limited to the 3 onboarding markets), which
// only InvoiceFormModal itself used to check, as a fallback of a fallback.
// This is the one place a multi-market firm can deliberately say "AED, not
// whatever picking UAE-then-UK in that order happened to resolve to" — now
// it's checked FIRST here, so every screen this hook powers (Candidates,
// Jobs, JobFormModal, Overview, Invoices, Pipeline) agrees with it, not
// just new-invoice defaults. Still falls back to guessing from
// onboarding.locations for a team that has never opened Settings ->
// Invoicing (no invoicing_details row exists yet to have an opinion).
export function useMarketCurrency() {
  const { user } = useAuth()
  const [currencyCode, setCurrencyCode] = useState(DEFAULT_CURRENCY_CODE)

  useEffect(() => {
    if (!user) return
    // Best-effort, run in parallel — a failure in either leaves whichever
    // half did resolve (or the sensible GBP default) in place. Never worth
    // surfacing as a page error over a currency label.
    Promise.all([
      supabase.from('onboarding').select('locations').eq('user_id', user.id).single().then(r => r.data, () => null),
      getInvoicingDetails().catch(() => null),
    ]).then(([onboardingRow, invoicingDetails]) => {
      setCurrencyCode(invoicingDetails?.default_currency || resolveMarketCurrencyCode(onboardingRow?.locations))
    })
  }, [user])

  const currencyPrefix = useMemo(() => {
    const symbol = currencySymbol(currencyCode)
    return symbol.length > 1 ? `${symbol} ` : symbol
  }, [currencyCode])

  const currencyLabel = useMemo(() => currencySymbol(currencyCode).trim(), [currencyCode])

  return { currencyCode, currencyPrefix, currencyLabel }
}
