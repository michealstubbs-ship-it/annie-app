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

// The governing constraint on top-up pricing changed when Starter was removed.
//
// It used to be "a top-up must never be cheaper per credit than upgrading",
// measured on Starter $79/50 credits -> Growth $129/150 credits = $0.50 per
// extra credit. With Starter gone there is no credit-driven upgrade left: Solo
// to Team is a seat and collaboration decision, not a way to buy credits, so
// that comparison no longer means anything.
//
// The constraint that replaces it is a floor, and it is measured rather than
// assumed. Apollo overage costs $0.20 per credit (verified against the live
// account, 2026-09-05), and a credit is consumed whenever Apollo matches a
// PERSON — roughly half of which carry no email — so the true cost per USABLE
// contact is about double the headline rate. A pack priced under that loses
// money on every sale.
const APOLLO_OVERAGE_PER_CREDIT = 0.20
const REALISTIC_COST_PER_CREDIT = APOLLO_OVERAGE_PER_CREDIT * 2

describe('top-up pricing must never sell credits below what they cost', () => {
  it('prices every pack above the real per-credit cost, with margin', () => {
    for (const pack of TOPUP_PACKS) {
      const perCredit = pack.priceUsd / pack.credits
      expect(perCredit).toBeGreaterThan(REALISTIC_COST_PER_CREDIT)
    }
  })

  it('keeps larger packs cheaper per credit than smaller ones, or the ladder makes no sense', () => {
    const perCredit = TOPUP_PACKS.map(p => p.priceUsd / p.credits)
    for (let i = 1; i < perCredit.length; i += 1) {
      expect(perCredit[i]).toBeLessThan(perCredit[i - 1])
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
