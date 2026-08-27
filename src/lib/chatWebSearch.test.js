import { describe, it, expect } from 'vitest'
import { shouldSearchWeb } from './chatWebSearch'

describe('shouldSearchWeb', () => {
  it('triggers on explicit current-market questions', () => {
    expect(shouldSearchWeb("What's happening in the UK legal market right now?")).toBe(true)
    expect(shouldSearchWeb('Any latest news on Kearney Dubai?')).toBe(true)
    expect(shouldSearchWeb('What are the current hiring trends this month?')).toBe(true)
  })

  it('triggers when asking whether a specific company recently did something', () => {
    expect(shouldSearchWeb('Has Deloitte announced any expansion recently?')).toBe(true)
  })

  it('does not trigger on requests that do not need live information', () => {
    expect(shouldSearchWeb('Draft an outreach email to a new prospect')).toBe(false)
    expect(shouldSearchWeb('Help me prepare for a BD call')).toBe(false)
    expect(shouldSearchWeb('Write a LinkedIn message for a warm lead')).toBe(false)
    expect(shouldSearchWeb('How should I handle a candidate with three competing offers?')).toBe(false)
  })

  it('handles empty/non-string input safely', () => {
    expect(shouldSearchWeb('')).toBe(false)
    expect(shouldSearchWeb(null)).toBe(false)
    expect(shouldSearchWeb(undefined)).toBe(false)
  })
})
