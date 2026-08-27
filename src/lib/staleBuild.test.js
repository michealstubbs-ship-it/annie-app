import { describe, it, expect, vi } from 'vitest'
import { checkUrlsStale, isTabStale } from './staleBuild.js'

describe('checkUrlsStale', () => {
  it('returns false when there is nothing to check', async () => {
    expect(await checkUrlsStale([], vi.fn())).toBe(false)
  })

  it('returns false when every URL still resolves ok', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true })
    expect(await checkUrlsStale(['/assets/index-AAA.js'], fetchImpl)).toBe(false)
  })

  it('returns true when a URL comes back not-ok (the exact stale-deploy signature)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false })
    expect(await checkUrlsStale(['/assets/index-AAA.js'], fetchImpl)).toBe(true)
  })

  it('returns true if even one of several URLs is stale, not just the first', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false })
    expect(await checkUrlsStale(['/assets/index-AAA.js', '/assets/Chat-BBB.js'], fetchImpl)).toBe(true)
  })

  it('every URL is HEAD-checked with cache disabled, not just the first', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true })
    await checkUrlsStale(['/a.js', '/b.js'], fetchImpl)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl).toHaveBeenCalledWith('/a.js', { method: 'HEAD', cache: 'no-store' })
    expect(fetchImpl).toHaveBeenCalledWith('/b.js', { method: 'HEAD', cache: 'no-store' })
  })

  it('treats a thrown fetch error as "could not tell" rather than as stale — a real outage is not a stale deploy', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    expect(await checkUrlsStale(['/assets/index-AAA.js'], fetchImpl)).toBe(false)
  })
})

describe('isTabStale', () => {
  it('returns false when there is no document to read script tags from (non-browser context)', async () => {
    expect(await isTabStale(vi.fn())).toBe(false)
  })
})
