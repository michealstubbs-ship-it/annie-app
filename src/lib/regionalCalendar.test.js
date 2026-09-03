import { describe, it, expect } from 'vitest'
import { effectiveDaysInStage, isInHiringSurge, activeSlowWindow } from './regionalCalendar.js'

describe('effectiveDaysInStage', () => {
  it('returns 0 for no start date', () => {
    expect(effectiveDaysInStage(null)).toBe(0)
  })

  it('counts a full day-for-day outside any slow window', () => {
    const since = new Date('2026-01-01')
    const now = new Date('2026-01-11')
    expect(effectiveDaysInStage(since, now)).toBe(10)
  })

  it('counts Ramadan days at half rate', () => {
    // 10 calendar days entirely inside Ramadan 2026 (Feb 19 - Mar 19) -> 5 effective days
    const since = new Date('2026-02-20')
    const now = new Date('2026-03-02')
    expect(effectiveDaysInStage(since, now)).toBe(5)
  })

  it('excludes Eid days from the clock entirely', () => {
    // Mar 20-22 is Eid (factor 0) -> spanning exactly those 2 days counts as 0
    const since = new Date('2026-03-20')
    const now = new Date('2026-03-22')
    expect(effectiveDaysInStage(since, now)).toBe(0)
  })

  it('correctly blends a span that straddles a slow window boundary', () => {
    // Feb 17 -> Feb 21: Feb 17-18 normal (2 days), Feb 19-20 Ramadan half-rate (2 days -> 1)
    const since = new Date('2026-02-17')
    const now = new Date('2026-02-21')
    expect(effectiveDaysInStage(since, now)).toBe(3)
  })

  it('returns 0 for the same day', () => {
    const d = new Date('2026-01-01')
    expect(effectiveDaysInStage(d, d)).toBe(0)
  })
})

describe('isInHiringSurge', () => {
  it('is true inside the post-Eid surge window', () => {
    expect(isInHiringSurge(new Date('2026-04-15'))).toBe(true)
  })

  it('is false outside the surge window', () => {
    expect(isInHiringSurge(new Date('2026-01-15'))).toBe(false)
    expect(isInHiringSurge(new Date('2026-08-01'))).toBe(false)
  })
})

describe('activeSlowWindow', () => {
  it('returns the matching window during Ramadan', () => {
    expect(activeSlowWindow(new Date('2026-03-01'))?.name).toBe('Ramadan 2026')
  })

  it('returns null outside any slow window', () => {
    expect(activeSlowWindow(new Date('2026-06-01'))).toBeNull()
  })
})
