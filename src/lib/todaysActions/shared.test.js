import { describe, it, expect, vi, afterEach } from 'vitest'
import { daysSince, statusWeight, decayRise, decayFall, norm, MIN_SCORE } from './shared.js'

describe('daysSince', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns null for a missing/empty date', () => {
    expect(daysSince(null)).toBeNull()
    expect(daysSince(undefined)).toBeNull()
    expect(daysSince('')).toBeNull()
  })

  it('computes whole days elapsed since a past date', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T00:00:00Z'))
    expect(daysSince('2026-08-20T00:00:00Z')).toBe(4)
  })

  it('floors a partial day rather than rounding', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T12:00:00Z'))
    expect(daysSince('2026-08-24T00:00:00Z')).toBe(0)
    expect(daysSince('2026-08-23T13:00:00Z')).toBe(0)
    expect(daysSince('2026-08-23T00:00:00Z')).toBe(1)
  })
})

describe('statusWeight', () => {
  it('returns the documented weight for each known status', () => {
    expect(statusWeight('hot')).toBe(30)
    expect(statusWeight('warm')).toBe(18)
    expect(statusWeight('cold')).toBe(8)
    expect(statusWeight('client')).toBe(0)
    expect(statusWeight('inactive')).toBe(0)
  })

  it('falls back to 10 for an unknown/missing status', () => {
    expect(statusWeight('made_up_status')).toBe(10)
    expect(statusWeight(undefined)).toBe(10)
    expect(statusWeight(null)).toBe(10)
  })
})

describe('decayRise', () => {
  it('is 0 at x = 0 and for any non-positive x', () => {
    expect(decayRise(0, 10, 100)).toBe(0)
    expect(decayRise(-5, 10, 100)).toBe(0)
  })

  it('rises toward max but never reaches or exceeds it', () => {
    const v1 = decayRise(10, 10, 100)
    const v2 = decayRise(50, 10, 100)
    expect(v1).toBeGreaterThan(0)
    expect(v1).toBeLessThan(100)
    expect(v2).toBeLessThan(100)
    expect(v2).toBeGreaterThan(v1)
  })

  it('gets arbitrarily close to max as x grows large', () => {
    expect(decayRise(100000, 10, 100)).toBeGreaterThan(99.99)
  })
})

describe('decayFall', () => {
  it('is at (or essentially at) max when x = 0', () => {
    expect(decayFall(0, 10, 100)).toBeCloseTo(100, 5)
  })

  it('falls toward 0 as x grows, and never goes negative', () => {
    const v1 = decayFall(10, 10, 100)
    const v2 = decayFall(1000, 10, 100)
    expect(v1).toBeLessThan(100)
    expect(v1).toBeGreaterThan(0)
    expect(v2).toBeGreaterThan(0)
    expect(v2).toBeLessThan(v1)
  })

  it('clamps a negative x to behave like x = 0 rather than rising above max', () => {
    expect(decayFall(-50, 10, 100)).toBeCloseTo(100, 5)
  })
})

describe('norm', () => {
  it('trims and lowercases', () => {
    expect(norm('  Acme LTD  ')).toBe('acme ltd')
  })

  it('returns an empty string for null/undefined/empty input', () => {
    expect(norm(null)).toBe('')
    expect(norm(undefined)).toBe('')
    expect(norm('')).toBe('')
  })
})

describe('MIN_SCORE', () => {
  it('is the documented quality bar of 20', () => {
    expect(MIN_SCORE).toBe(20)
  })
})
