import { describe, it, expect } from 'vitest'
import { describeChatFailure } from './chatErrorMessage.js'

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
})
