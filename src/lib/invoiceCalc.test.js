import { describe, it, expect } from 'vitest'
import { lineItemAmount, computeInvoiceTotals, currencySymbol, formatMoney, getGuaranteeStatus, guaranteeStatusLabel } from './invoiceCalc.js'

describe('lineItemAmount', () => {
  it('multiplies quantity by unit amount', () => {
    expect(lineItemAmount(1, 12500)).toBe(12500)
    expect(lineItemAmount(3, 100)).toBe(300)
  })

  it('handles fractional quantities without floating-point drift', () => {
    expect(lineItemAmount(0.5, 100)).toBe(50)
    expect(lineItemAmount(2.5, 10.1)).toBeCloseTo(25.25, 2)
  })

  it('treats a missing/invalid quantity or amount as 0', () => {
    expect(lineItemAmount(undefined, 100)).toBe(0)
    expect(lineItemAmount(2, undefined)).toBe(0)
  })
})

describe('computeInvoiceTotals', () => {
  it('sums line item amounts with no tax', () => {
    const totals = computeInvoiceTotals([{ amount: 12500 }, { amount: 500 }], 0)
    expect(totals).toEqual({ subtotal: 13000, taxAmount: 0, total: 13000 })
  })

  it('applies a tax rate to the subtotal once, not per line', () => {
    const totals = computeInvoiceTotals([{ amount: 100 }, { amount: 200 }], 5)
    // subtotal 300, 5% = 15, not 5+10=15 either way here, but proves it's
    // computed off the combined subtotal rather than summed per-line by
    // using a rate that would round differently per-line vs combined.
    expect(totals.subtotal).toBe(300)
    expect(totals.taxAmount).toBe(15)
    expect(totals.total).toBe(315)
  })

  it('avoids classic floating-point drift across several decimal line items', () => {
    const totals = computeInvoiceTotals([{ amount: 0.1 }, { amount: 0.2 }], 0)
    expect(totals.subtotal).toBe(0.3)
  })

  it('returns all zeros for an empty line item list', () => {
    expect(computeInvoiceTotals([], 5)).toEqual({ subtotal: 0, taxAmount: 0, total: 0 })
    expect(computeInvoiceTotals(null, 5)).toEqual({ subtotal: 0, taxAmount: 0, total: 0 })
  })

  it('treats a missing/null/undefined tax rate as 0%', () => {
    expect(computeInvoiceTotals([{ amount: 100 }], null).taxAmount).toBe(0)
    expect(computeInvoiceTotals([{ amount: 100 }], undefined).taxAmount).toBe(0)
  })
})

describe('currencySymbol / formatMoney', () => {
  it('resolves a known currency to its symbol', () => {
    expect(currencySymbol('USD')).toBe('$')
    expect(currencySymbol('AED')).toBe('AED')
  })

  it('falls back to the raw code for an unknown currency rather than throwing', () => {
    expect(currencySymbol('XYZ')).toBe('XYZ')
  })

  it('formats an amount with its currency symbol and two decimal places', () => {
    expect(formatMoney(1250, 'AED')).toBe('AED 1,250.00')
    expect(formatMoney(1250.5, 'SAR')).toBe('SAR 1,250.50')
  })

  // 2026-08-29 audit fix: a single-character symbol (£, $, €) reads
  // correctly with no space — "£ 1,250.00" was the bug an invoice screen
  // actually showed in production. Only a multi-character code (AED, SAR)
  // needs the space to read as a prefix at all.
  it('does NOT put a space after a single-character symbol', () => {
    expect(formatMoney(1250, 'USD')).toBe('$1,250.00')
    expect(formatMoney(1250, 'GBP')).toBe('£1,250.00')
    expect(formatMoney(1250, 'EUR')).toBe('€1,250.00')
  })
})

// 2026-09-03, Michael ("rebate/guarantee period tracking"): pure day-math,
// so every case here pins an explicit `today` rather than depending on the
// real clock.
describe('getGuaranteeStatus', () => {
  const TODAY = new Date('2026-09-03T00:00:00Z')

  it('is "not_started" when there is no guarantee_starts_at yet', () => {
    expect(getGuaranteeStatus({}, TODAY)).toEqual({ state: 'not_started', daysLeft: null, daysElapsed: null })
  })

  it('is "triggered" once a rebate/replacement has actually happened, regardless of remaining days', () => {
    const status = getGuaranteeStatus({ guarantee_starts_at: '2026-08-01', guarantee_days: 90, rebate_triggered_at: '2026-08-20' }, TODAY)
    expect(status).toEqual({ state: 'triggered', daysLeft: null, daysElapsed: null })
  })

  it('is "active" with plenty of days left', () => {
    const status = getGuaranteeStatus({ guarantee_starts_at: '2026-09-01', guarantee_days: 90 }, TODAY)
    expect(status.state).toBe('active')
    expect(status.daysLeft).toBe(88)
    expect(status.daysElapsed).toBe(2)
  })

  it('is "ending_soon" inside the last 14 days', () => {
    const status = getGuaranteeStatus({ guarantee_starts_at: '2026-06-15', guarantee_days: 90 }, TODAY)
    expect(status.state).toBe('ending_soon')
    expect(status.daysLeft).toBeGreaterThan(0)
    expect(status.daysLeft).toBeLessThanOrEqual(14)
  })

  it('is "expired" once the window has fully passed, clamped at 0 rather than going negative', () => {
    const status = getGuaranteeStatus({ guarantee_starts_at: '2026-01-01', guarantee_days: 90 }, TODAY)
    expect(status.state).toBe('expired')
    expect(status.daysLeft).toBe(0)
  })

  it('defaults guarantee_days to 90 when missing/invalid', () => {
    const withDefault = getGuaranteeStatus({ guarantee_starts_at: '2026-09-01' }, TODAY)
    const explicit90 = getGuaranteeStatus({ guarantee_starts_at: '2026-09-01', guarantee_days: 90 }, TODAY)
    expect(withDefault).toEqual(explicit90)
  })
})

describe('guaranteeStatusLabel', () => {
  it('renders each state as a distinct plain-language label', () => {
    expect(guaranteeStatusLabel({ state: 'not_started' })).toMatch(/not started/i)
    expect(guaranteeStatusLabel({ state: 'triggered' })).toMatch(/triggered/i)
    expect(guaranteeStatusLabel({ state: 'expired' })).toMatch(/ended/i)
    expect(guaranteeStatusLabel({ state: 'ending_soon', daysLeft: 5 })).toBe('Guarantee ends in 5 days')
    expect(guaranteeStatusLabel({ state: 'ending_soon', daysLeft: 1 })).toBe('Guarantee ends in 1 day')
    expect(guaranteeStatusLabel({ state: 'active', daysLeft: 60 })).toBe('60 days left on guarantee')
  })
})
