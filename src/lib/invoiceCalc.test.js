import { describe, it, expect } from 'vitest'
import { lineItemAmount, computeInvoiceTotals, currencySymbol, formatMoney } from './invoiceCalc.js'

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
