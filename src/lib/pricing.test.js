import { describe, it, expect } from 'vitest'
import { TIERS, tierByKey, monthlyRevenueFor, canonicalTier } from './pricing.js'

describe('tierByKey', () => {
  it('finds a known tier', () => {
    expect(tierByKey('solo').name).toBe('Solo')
    expect(tierByKey('team').name).toBe('Team')
  })

  it('returns null for an unknown tier', () => {
    expect(tierByKey('enterprise')).toBeNull()
  })

  // Stripe still sends the key a subscription was created with, so a live
  // webhook can say 'growth' long after the database has been migrated.
  // Resolving it here is what stops that customer silently losing their plan.
  it('resolves the retired tier keys to Solo', () => {
    expect(tierByKey('growth').name).toBe('Solo')
    expect(tierByKey('starter').name).toBe('Solo')
  })
})

describe('canonicalTier', () => {
  it('maps the retired keys and leaves live ones alone', () => {
    expect(canonicalTier('growth')).toBe('solo')
    expect(canonicalTier('starter')).toBe('solo')
    expect(canonicalTier('solo')).toBe('solo')
    expect(canonicalTier('team')).toBe('team')
  })

  it('passes an unknown key through rather than guessing', () => {
    expect(canonicalTier('enterprise')).toBe('enterprise')
    expect(canonicalTier(null)).toBeNull()
    expect(canonicalTier(undefined)).toBeNull()
  })
})

describe('monthlyRevenueFor', () => {
  it('uses the monthly rate for a monthly Solo subscription', () => {
    expect(monthlyRevenueFor({ tier: 'solo', billing_interval: 'month', seats: 1 })).toBe(129)
  })

  it('uses the (already-monthly) yearly rate for a yearly subscription, not yearly * 12', () => {
    expect(monthlyRevenueFor({ tier: 'solo', billing_interval: 'year', seats: 1 })).toBe(109)
  })

  // A subscription row still carrying the old key must keep contributing its
  // real revenue, or MRR silently under-reports every un-migrated customer.
  it('counts a retired tier key at the Solo rate rather than zero', () => {
    expect(monthlyRevenueFor({ tier: 'growth', billing_interval: 'month', seats: 1 })).toBe(129)
  })

  it('multiplies by seats only for the per-seat Team tier', () => {
    expect(monthlyRevenueFor({ tier: 'team', billing_interval: 'month', seats: 3 })).toBe(99 * 3)
  })

  it('ignores seats for a non-per-seat tier', () => {
    expect(monthlyRevenueFor({ tier: 'solo', billing_interval: 'month', seats: 5 })).toBe(129)
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
