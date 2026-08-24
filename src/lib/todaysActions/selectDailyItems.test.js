import { describe, it, expect } from 'vitest'
import { selectDailyItems } from './selectDailyItems.js'

describe('selectDailyItems', () => {
  it('filters out anything below MIN_SCORE and sorts urgency first, then score', () => {
    const pools = {
      a: [{ category: 'x', score: 10, urgency: 0 }], // below bar, excluded
      b: [{ category: 'x', score: 50, urgency: 0 }],
      c: [{ category: 'x', score: 30, urgency: 1 }], // lower score but higher urgency, should rank first
    }
    const result = selectDailyItems(pools)
    expect(result).toHaveLength(2)
    expect(result[0].urgency).toBe(1)
    expect(result[1].score).toBe(50)
  })

  it('has no per-category cap — every qualifying item from every pool shows', () => {
    const pools = {
      a: Array.from({ length: 5 }, () => ({ category: 'a', score: 40, urgency: 0 })),
      b: Array.from({ length: 5 }, () => ({ category: 'b', score: 40, urgency: 0 })),
    }
    expect(selectDailyItems(pools)).toHaveLength(10)
  })
})
