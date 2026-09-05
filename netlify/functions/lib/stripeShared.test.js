import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { PRICE_ENV_VARS, priceIdFor, resolveTierFromPriceId } from './stripeShared.js'

const ALL_ENV_VARS = Object.values(PRICE_ENV_VARS).flatMap(intervals => Object.values(intervals))

describe('priceIdFor', () => {
  const savedEnv = {}

  beforeEach(() => {
    for (const name of ALL_ENV_VARS) {
      savedEnv[name] = process.env[name]
      delete process.env[name]
    }
  })

  afterEach(() => {
    for (const name of ALL_ENV_VARS) {
      if (savedEnv[name] === undefined) delete process.env[name]
      else process.env[name] = savedEnv[name]
    }
  })

  it('maps every real (tier, interval) combination to the right env-var-backed price ID', () => {
    process.env.STRIPE_PRICE_STARTER_MONTHLY = 'price_solo_month'
    process.env.STRIPE_PRICE_STARTER_YEARLY = 'price_solo_year'
    process.env.STRIPE_PRICE_GROWTH_MONTHLY = 'price_solo_month'
    process.env.STRIPE_PRICE_GROWTH_YEARLY = 'price_solo_year'
    process.env.STRIPE_PRICE_TEAM_MONTHLY = 'price_team_month'
    process.env.STRIPE_PRICE_TEAM_YEARLY = 'price_team_year'

    expect(priceIdFor('solo', 'month')).toBe('price_solo_month')
    expect(priceIdFor('solo', 'year')).toBe('price_solo_year')
    expect(priceIdFor('solo', 'month')).toBe('price_solo_month')
    expect(priceIdFor('solo', 'year')).toBe('price_solo_year')
    expect(priceIdFor('team', 'month')).toBe('price_team_month')
    expect(priceIdFor('team', 'year')).toBe('price_team_year')
  })

  it('returns falsy for an unknown tier', () => {
    expect(priceIdFor('enterprise', 'month')).toBeFalsy()
    expect(priceIdFor('bogus', 'year')).toBeFalsy()
  })

  it('returns falsy for an unknown interval on a real tier', () => {
    process.env.STRIPE_PRICE_STARTER_MONTHLY = 'price_solo_month'
    expect(priceIdFor('solo', 'week')).toBeFalsy()
    expect(priceIdFor('solo', undefined)).toBeFalsy()
  })

  it('returns falsy (not the env var name) when the mapped env var is simply unset', () => {
    // STRIPE_PRICE_GROWTH_MONTHLY deliberately left unset by beforeEach.
    expect(priceIdFor('solo', 'month')).toBeFalsy()
  })

  it('returns falsy for null/undefined tier or interval rather than throwing', () => {
    expect(priceIdFor(null, 'month')).toBeFalsy()
    expect(priceIdFor('solo', null)).toBeFalsy()
    expect(priceIdFor(undefined, undefined)).toBeFalsy()
  })
})

describe('resolveTierFromPriceId', () => {
  const savedEnv = {}

  beforeEach(() => {
    for (const name of ALL_ENV_VARS) {
      savedEnv[name] = process.env[name]
      delete process.env[name]
    }
    process.env.STRIPE_PRICE_STARTER_MONTHLY = 'price_solo_month'
    process.env.STRIPE_PRICE_STARTER_YEARLY = 'price_solo_year'
    process.env.STRIPE_PRICE_GROWTH_MONTHLY = 'price_solo_month'
    process.env.STRIPE_PRICE_GROWTH_YEARLY = 'price_solo_year'
    process.env.STRIPE_PRICE_TEAM_MONTHLY = 'price_team_month'
    process.env.STRIPE_PRICE_TEAM_YEARLY = 'price_team_year'
  })

  afterEach(() => {
    for (const name of ALL_ENV_VARS) {
      if (savedEnv[name] === undefined) delete process.env[name]
      else process.env[name] = savedEnv[name]
    }
  })

  it('resolves every configured price ID back to its exact tier/interval', () => {
    expect(resolveTierFromPriceId('price_solo_month')).toEqual({ tier: 'solo', interval: 'month' })
    expect(resolveTierFromPriceId('price_solo_year')).toEqual({ tier: 'solo', interval: 'year' })
    expect(resolveTierFromPriceId('price_solo_month')).toEqual({ tier: 'solo', interval: 'month' })
    expect(resolveTierFromPriceId('price_solo_year')).toEqual({ tier: 'solo', interval: 'year' })
    expect(resolveTierFromPriceId('price_team_month')).toEqual({ tier: 'team', interval: 'month' })
    expect(resolveTierFromPriceId('price_team_year')).toEqual({ tier: 'team', interval: 'year' })
  })

  it('returns null/null for an unrecognized price ID', () => {
    expect(resolveTierFromPriceId('price_does_not_exist')).toEqual({ tier: null, interval: null })
  })

  it('returns null/null for a falsy price ID rather than throwing', () => {
    expect(resolveTierFromPriceId(null)).toEqual({ tier: null, interval: null })
    expect(resolveTierFromPriceId(undefined)).toEqual({ tier: null, interval: null })
    expect(resolveTierFromPriceId('')).toEqual({ tier: null, interval: null })
  })

  it('is the true inverse of priceIdFor for every real combination', () => {
    for (const tier of Object.keys(PRICE_ENV_VARS)) {
      for (const interval of Object.keys(PRICE_ENV_VARS[tier])) {
        const priceId = priceIdFor(tier, interval)
        expect(resolveTierFromPriceId(priceId)).toEqual({ tier, interval })
      }
    }
  })
})
