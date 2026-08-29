import { describe, it, expect } from 'vitest'
import { recentHistory, RECENT_HISTORY_LIMIT } from './chatHistory'

// A real conversation always strictly alternates starting with 'user' —
// build fixtures that way so tests actually exercise the role-alignment
// logic, not just length trimming.
function buildAlternating(n) {
  return Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `msg ${i}` }))
}

function isValidForAnthropic(messages) {
  if (!messages.length) return true
  if (messages[0].role !== 'user') return false
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].role === messages[i - 1].role) return false
  }
  return true
}

describe('recentHistory', () => {
  it('returns everything unchanged when there are fewer messages than the limit', () => {
    const messages = buildAlternating(5)
    expect(recentHistory(messages)).toEqual(messages)
  })

  it('returns everything unchanged when there are exactly the limit', () => {
    const messages = buildAlternating(RECENT_HISTORY_LIMIT)
    expect(recentHistory(messages)).toEqual(messages)
  })

  it('never mutates the array it was given', () => {
    const messages = buildAlternating(RECENT_HISTORY_LIMIT + 5)
    const originalLength = messages.length
    recentHistory(messages)
    expect(messages).toHaveLength(originalLength)
  })

  it('handles an empty conversation', () => {
    expect(recentHistory([])).toEqual([])
  })

  // The actual bug: a long conversation used to send every message ever
  // sent in the tab, growing the prompt without limit.
  it('trims a long conversation and always keeps the newest message', () => {
    const messages = buildAlternating(RECENT_HISTORY_LIMIT + 37)
    const result = recentHistory(messages)
    expect(result[result.length - 1].content).toBe(`msg ${RECENT_HISTORY_LIMIT + 36}`)
    expect(result.length).toBeLessThanOrEqual(RECENT_HISTORY_LIMIT)
  })

  // A plain slice(-20) can land on an 'assistant' message once the
  // conversation is longer than the window — Anthropic's API requires the
  // first message to be 'user' and to strictly alternate throughout.
  it('always returns a result valid for the Anthropic Messages API, regardless of length', () => {
    for (let total = 1; total <= 60; total++) {
      const result = recentHistory(buildAlternating(total))
      expect(isValidForAnthropic(result)).toBe(true)
    }
  })

  // 47 messages: slice(-20) would land on index 27 ('assistant'), which
  // gets dropped to realign — final recent is 19 messages starting at
  // index 28 ('user').
  it('drops a leading assistant message that a raw slice would have produced, to stay user-first', () => {
    const messages = buildAlternating(47)
    const result = recentHistory(messages)
    expect(result[0].role).toBe('user')
    expect(result[0].content).not.toBe('msg 27')
  })

  // Anything just outside the verbatim window gets condensed into the
  // first retained message instead of vanishing outright.
  it('folds messages just outside the window into a digest on the first retained message, instead of dropping them', () => {
    const messages = buildAlternating(RECENT_HISTORY_LIMIT + 40) // = 60, well past both tiers
    const result = recentHistory(messages)
    // Something from well before the verbatim window should still be
    // findable in the digest text.
    expect(result[0].content).toContain('msg 20')
    expect(result[0].content).toContain('Earlier in this conversation')
    // The message's own real content is still there too, just prefixed.
    expect(result[0].content).toMatch(/msg \d+$/)
  })

  it('drops content older than both tiers entirely — a deliberate, bounded trade-off', () => {
    const messages = buildAlternating(200)
    const result = recentHistory(messages)
    const combined = result.map(m => m.content).join(' ')
    expect(combined).not.toContain('msg 0 ') // the very first message is genuinely gone
    expect(result[result.length - 1].content).toBe('msg 199') // but the newest is always kept
  })
})
