import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { withTimeout, TIMEOUT_MESSAGE } from './withTimeout.js'

describe('withTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves with the original value when the promise settles well within the timeout', async () => {
    const promise = withTimeout(Promise.resolve('done'), 1000, 'test')
    await expect(promise).resolves.toBe('done')
  })

  it('rejects with the original error when the wrapped promise rejects before the timeout', async () => {
    const promise = withTimeout(Promise.reject(new Error('boom')), 1000, 'test')
    await expect(promise).rejects.toThrow('boom')
  })

  it('rejects with a TIMEOUT:<label> error once the timeout elapses before the promise settles', async () => {
    const neverResolves = new Promise(() => {})
    const promise = withTimeout(neverResolves, 5000, 'save-onboarding')
    const assertion = expect(promise).rejects.toThrow('TIMEOUT:save-onboarding')
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
  })

  it('does not fire the timeout rejection if the promise already resolved', async () => {
    const promise = withTimeout(Promise.resolve('ok'), 5000, 'test')
    const result = await promise
    // Advancing time after resolution should not cause any unhandled rejection.
    await vi.advanceTimersByTimeAsync(10000)
    expect(result).toBe('ok')
  })

  it('exports a human-readable TIMEOUT_MESSAGE mentioning browser extensions', () => {
    expect(typeof TIMEOUT_MESSAGE).toBe('string')
    expect(TIMEOUT_MESSAGE.toLowerCase()).toContain('extension')
  })
})
