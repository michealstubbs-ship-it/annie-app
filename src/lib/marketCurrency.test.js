import { describe, it, expect } from 'vitest'
import { resolveMarketCurrencyCode, MARKET_CURRENCY_CODE, DEFAULT_CURRENCY_CODE, isGccMarket } from './marketCurrency.js'

describe('resolveMarketCurrencyCode', () => {
  it('maps each known onboarding market to its real currency code', () => {
    expect(resolveMarketCurrencyCode(['United Kingdom'])).toBe('GBP')
    expect(resolveMarketCurrencyCode(['UAE / GCC'])).toBe('AED')
    expect(resolveMarketCurrencyCode(['United States'])).toBe('USD')
  })

  it('uses the first location when an account has more than one market', () => {
    expect(resolveMarketCurrencyCode(['United Kingdom', 'UAE / GCC'])).toBe('GBP')
  })

  it('falls back to GBP, not AED, for an empty, missing, or unrecognised locations value', () => {
    expect(resolveMarketCurrencyCode([])).toBe(DEFAULT_CURRENCY_CODE)
    expect(resolveMarketCurrencyCode(null)).toBe(DEFAULT_CURRENCY_CODE)
    expect(resolveMarketCurrencyCode(undefined)).toBe(DEFAULT_CURRENCY_CODE)
    expect(resolveMarketCurrencyCode(['Atlantis'])).toBe(DEFAULT_CURRENCY_CODE)
    expect(DEFAULT_CURRENCY_CODE).toBe('GBP')
  })

  it('exports the raw mapping for callers that need it directly', () => {
    expect(MARKET_CURRENCY_CODE['United Kingdom']).toBe('GBP')
  })
})

describe('isGccMarket', () => {
  it('is true only when UAE / GCC is one of the ticked markets', () => {
    expect(isGccMarket(['UAE / GCC'])).toBe(true)
    expect(isGccMarket(['United Kingdom'])).toBe(false)
    expect(isGccMarket(['United States'])).toBe(false)
  })

  it('checks the whole array, not just the first entry — a multi-market firm still needs GCC fields', () => {
    expect(isGccMarket(['United Kingdom', 'UAE / GCC'])).toBe(true)
    expect(isGccMarket(['UAE / GCC', 'United Kingdom'])).toBe(true)
  })

  it('is false for an empty, missing, or unrecognised locations value', () => {
    expect(isGccMarket([])).toBe(false)
    expect(isGccMarket(null)).toBe(false)
    expect(isGccMarket(undefined)).toBe(false)
    expect(isGccMarket(['Atlantis'])).toBe(false)
  })
})
