import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { TOPUP_PACKS, packByKey, topupPriceId, packFromPriceId, packsForDisplay } from '../lib/topups.js'
import { TIER_LIMITS } from '../lib/entitlements.js'

const ORIGINAL_ENV = { ...process.env }
beforeEach(() => {
  process.env.STRIPE_PRICE_TOPUP_25 = 'price_25'
  process.env.STRIPE_PRICE_TOPUP_75 = 'price_75'
  delete process.env.STRIPE_PRICE_TOPUP_200
})
afterEach(() => { process.env = { ...ORIGINAL_ENV } })

// The governing constraint on top-up pricing is not cost, it is that a top-up
// must never be cheaper per credit than upgrading. Otherwise a Starter
// customer tops up forever and the upgrade path dies. This test exists so that
// anyone changing a price has to consciously break it rather than do it by
// accident.
describe('top-up pricing must never undercut the upgrade', () => {
  it('prices every pack above the per-credit cost of upgrading Starter to Growth', () => {
    const extraCredits = TIER_LIMITS.growth.contactCreditsPerMonth - TIER_LIMITS.starter.contactCreditsPerMonth
    // Starter $79 -> Growth $129 is +$50 for those extra credits, and the
    // upgrade also brings unlimited Ask Annie and deeper scans.
    const upgradePerCredit = 50 / extraCredits
    expect(upgradePerCredit).toBeCloseTo(0.5, 2)

    for (const pack of TOPUP_PACKS) {
      const perCredit = pack.priceUsd / pack.credits
      expect(perCredit).toBeGreaterThan(upgradePerCredit)
    }
  })

  it('keeps a real margin over Apollo own overage rate of $0.20 a credit', () => {
    // One delivered contact is one Apollo credit — searches and failed reveals
    // are free, verified against the live API on 2026-09-04.
    for (const pack of TOPUP_PACKS) {
      const perCredit = pack.priceUsd / pack.credits
      expect(perCredit).toBeGreaterThan(0.2 * 2.5)
    }
  })

  it('gets cheaper per credit as the pack gets bigger, so the ladder makes sense', () => {
    const rates = TOPUP_PACKS.map(p => p.priceUsd / p.credits)
    for (let i = 1; i < rates.length; i++) expect(rates[i]).toBeLessThan(rates[i - 1])
  })

  it('has no pack small enough to cost more in card fees than it earns', () => {
    for (const pack of TOPUP_PACKS) expect(pack.priceUsd).toBeGreaterThanOrEqual(20)
  })
})

describe('pack lookup', () => {
  it('resolves a price id from a pack key', () => {
    expect(topupPriceId('small')).toBe('price_25')
  })

  it('returns null for a pack with no Stripe price configured, rather than a broken checkout', () => {
    expect(topupPriceId('large')).toBeNull()
  })

  it('resolves a pack back from the price id Stripe reports', () => {
    // The webhook grants off this, never off metadata — a price id is the one
    // thing Stripe guarantees stays accurate.
    expect(packFromPriceId('price_75')?.credits).toBe(75)
  })

  it('refuses to recognise a price that is not one of ours', () => {
    expect(packFromPriceId('price_someone_elses')).toBeNull()
    expect(packFromPriceId(null)).toBeNull()
  })

  it('marks unconfigured packs so the UI can hide them instead of offering a dead button', () => {
    const display = packsForDisplay()
    expect(display.find(p => p.key === 'small').configured).toBe(true)
    expect(display.find(p => p.key === 'large').configured).toBe(false)
  })

  it('derives the per-credit figure rather than storing it twice', () => {
    const small = packsForDisplay().find(p => p.key === 'small')
    expect(small.perCredit).toBe(1)
  })

  it('returns null for an unknown pack key', () => {
    expect(packByKey('enormous')).toBeNull()
  })
})
