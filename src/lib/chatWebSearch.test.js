import { describe, it, expect } from 'vitest'
import { shouldSearchWeb } from './chatWebSearch'

describe('shouldSearchWeb', () => {
  it('triggers on explicit current-market questions (unchanged from the old allow-list)', () => {
    expect(shouldSearchWeb("What's happening in the UK legal market right now?")).toBe(true)
    expect(shouldSearchWeb('Any latest news on Kearney Dubai?')).toBe(true)
    expect(shouldSearchWeb('What are the current hiring trends this month?')).toBe(true)
  })

  it('triggers when asking whether a specific company recently did something', () => {
    expect(shouldSearchWeb('Has Deloitte announced any expansion recently?')).toBe(true)
  })

  // 2026-09-01: the actual bug report — a bare "tell me about this company"
  // question has no recency keyword at all, so the old allow-list never
  // triggered a search and Annie answered "isn't in my tracked companies"
  // instead of looking it up. Now the default.
  it('triggers on a plain company lookup with no recency keyword at all', () => {
    expect(shouldSearchWeb('Al-Akaria in Saudi')).toBe(true)
    expect(shouldSearchWeb('What does Kearney do?')).toBe(true)
    expect(shouldSearchWeb('Tell me about Fasset')).toBe(true)
  })

  it('does not trigger on drafting/coaching requests that do not need live information', () => {
    expect(shouldSearchWeb('Draft an outreach email to a new prospect')).toBe(false)
    expect(shouldSearchWeb('Help me prepare for a BD call')).toBe(false)
    expect(shouldSearchWeb('Write a LinkedIn message for a warm lead')).toBe(false)
    expect(shouldSearchWeb('How should I handle a candidate with three competing offers?')).toBe(false)
  })

  it('does not trigger on a bare pleasantry', () => {
    expect(shouldSearchWeb('Thanks!')).toBe(false)
    expect(shouldSearchWeb('ok')).toBe(false)
    expect(shouldSearchWeb('Sounds good')).toBe(false)
  })

  it('handles empty/non-string input safely', () => {
    expect(shouldSearchWeb('')).toBe(false)
    expect(shouldSearchWeb('   ')).toBe(false)
    expect(shouldSearchWeb(null)).toBe(false)
    expect(shouldSearchWeb(undefined)).toBe(false)
  })
})
