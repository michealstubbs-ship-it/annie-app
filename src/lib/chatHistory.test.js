import { describe, it, expect } from 'vitest'
import { recentHistory, RECENT_HISTORY_LIMIT } from './chatHistory'

describe('recentHistory', () => {
  it('returns everything unchanged when there are fewer messages than the limit', () => {
    const messages = Array.from({ length: 5 }, (_, i) => ({ role: 'user', content: `msg ${i}` }))
    expect(recentHistory(messages)).toEqual(messages)
  })

  it('returns exactly the limit when there are exactly that many messages', () => {
    const messages = Array.from({ length: RECENT_HISTORY_LIMIT }, (_, i) => ({ role: 'user', content: `msg ${i}` }))
    expect(recentHistory(messages)).toEqual(messages)
  })

  // The actual bug this fixes: a long-running conversation used to send
  // every message ever sent in the tab, growing the prompt without limit.
  it('trims to only the most recent messages once history exceeds the limit, always keeping the newest', () => {
    const messages = Array.from({ length: RECENT_HISTORY_LIMIT + 37 }, (_, i) => ({ role: 'user', content: `msg ${i}` }))
    const result = recentHistory(messages)
    expect(result).toHaveLength(RECENT_HISTORY_LIMIT)
    expect(result[result.length - 1]).toEqual({ role: 'user', content: `msg ${RECENT_HISTORY_LIMIT + 36}` })
    expect(result[0]).toEqual({ role: 'user', content: 'msg 37' }) // the oldest message that survives the trim
  })

  it('never mutates the array it was given', () => {
    const messages = Array.from({ length: RECENT_HISTORY_LIMIT + 5 }, (_, i) => ({ role: 'user', content: `msg ${i}` }))
    const originalLength = messages.length
    recentHistory(messages)
    expect(messages).toHaveLength(originalLength)
  })

  it('handles an empty conversation', () => {
    expect(recentHistory([])).toEqual([])
  })
})
