import { describe, it, expect } from 'vitest'
import { TIERS, tierByKey, monthlyRevenueFor } from './pricing.js'

describe('tierByKey', () => {
  it('finds a known tier', () => {
    expect(tierByKey('growth').name).toBe('Growth')
  })

  it('returns null for an unknown tier', () => {
    expect(tierByKey('enterprise')).toBeNull()
  })
})

describe('monthlyRevenueFor', () => {
  it('uses the monthly rate for a monthly starter subscription', () => {
    expect(monthlyRevenueFor({ tier: 'starter', billing_interval: 'month', seats: 1 })).toBe(79)
  })

  it('uses the (already-monthly) yearly rate for a yearly subscription, not yearly * 12', () => {
    expect(monthlyRevenueFor({ tier: 'starter', billing_interval: 'year', seats: 1 })).toBe(69)
  })

  it('multiplies by seats only for the per-seat Team tier', () => {
    expect(monthlyRevenueFor({ tier: 'team', billing_interval: 'month', seats: 3 })).toBe(99 * 3)
  })

  it('ignores seats for a non-per-seat tier', () => {
    expect(monthlyRevenueFor({ tier: 'growth', billing_interval: 'month', seats: 5 })).toBe(129)
  })

  it('floors Team seats at 1 even if seats comes back 0 or missing', () => {
    expect(monthlyRevenueFor({ tier: 'team', billing_interval: 'month', seats: 0 })).toBe(99)
    expect(monthlyRevenueFor({ tier: 'team', billing_interval: 'month' })).toBe(99)
  })

  it('returns 0 for an unknown tier rather than throwing', () => {
    expect(monthlyRevenueFor({ tier: 'enterprise', billing_interval: 'month', seats: 1 })).toBe(0)
  })

  it('every tier stays defined with both monthly and yearly numeric prices', () => {
    for (const t of TIERS) {
      expect(typeof t.monthly).toBe('number')
      expect(typeof t.yearly).toBe('number')
      expect(t.yearly).toBeLessThanOrEqual(t.monthly)
    }
  })
})
