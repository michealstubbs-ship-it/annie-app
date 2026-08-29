import { describe, it, expect } from 'vitest'
import { describeChatFailure, describeStaleTab } from './chatErrorMessage.js'

describe('describeChatFailure', () => {
  it('passes a real server-sent error message through unchanged, with no reload suggestion', () => {
    const err = new Error("You've used all 100 Ask Annie messages included this month. Upgrade to Growth for unlimited messages.")
    const result = describeChatFailure(err)
    expect(result.text).toBe(err.message)
    expect(result.reloadSuggested).toBe(false)
  })

  it('falls back to the generic apology, with a reload suggestion, for the placeholder "Request failed" message', () => {
    const result = describeChatFailure(new Error('Request failed'))
    expect(result.reloadSuggested).toBe(true)
    expect(result.text).toMatch(/something went wrong/i)
    expect(result.text).toMatch(/reload/i)
  })

  it('falls back to the generic apology, with a reload suggestion, for a raw browser fetch error', () => {
    const result = describeChatFailure(new TypeError('Failed to fetch'))
    expect(result.reloadSuggested).toBe(true)
  })

  it('falls back to the generic apology, with a reload suggestion, for a network error string, case-insensitively', () => {
    const result = describeChatFailure(new Error('NetworkError when attempting to fetch resource.'))
    expect(result.reloadSuggested).toBe(true)
  })

  it('falls back to the generic apology, with a reload suggestion, when there is no message at all', () => {
    const result = describeChatFailure(new Error())
    expect(result.reloadSuggested).toBe(true)
  })

  it('falls back to the generic apology, with a reload suggestion, when err itself is missing', () => {
    const result = describeChatFailure(undefined)
    expect(result.reloadSuggested).toBe(true)
  })

  // 2026-08-29 audit fix: this message used to confidently tell the user
  // "we've shipped an update while this tab was open" for EVERY generic
  // network-shaped failure — including the actual, repeatable root cause
  // (a streamed reply killed by Netlify's 10s streaming execution limit,
  // nothing to do with a deploy). It has no way to know that's the reason,
  // so it must not claim it — that claim belongs only to describeStaleTab(),
  // which is reached from a real, confirmed isTabStale() check, not a guess.
  it('never claims a deploy/update as the reason — that is describeStaleTab\'s job, not this fallback\'s guess', () => {
    const result = describeChatFailure(new Error('Request failed'))
    expect(result.text).not.toMatch(/shipped an update/i)
    expect(result.text).not.toMatch(/previous version/i)
  })
})

describe('describeStaleTab', () => {
  it('states plainly that this tab is stale, with a reload suggestion — the confirmed case, not a guess', () => {
    const result = describeStaleTab()
    expect(result.reloadSuggested).toBe(true)
    expect(result.text).toMatch(/previous version/i)
    expect(result.text).toMatch(/reload/i)
  })
})
