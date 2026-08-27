// Same reasoning as errorReporting.test.js: ./supabase throws at import time
// without real env vars, so it's mocked rather than configured. This file
// only covers triggerScanNow — the plain async function extracted during
// the 2026-08-27 audit fix — not the useScanStatusPoll hook itself, which
// needs a real DOM/React render environment this repo's vitest config
// (environment: 'node') doesn't provide. The hook's own polling/merge logic
// (finish/poll/start) is unchanged by this fix and was already exercised
// indirectly through Settings.jsx/Overview.jsx before this pass.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./supabase', () => ({
  supabase: { auth: { getSession: vi.fn() } },
}))

const reportClientErrorMock = vi.fn()
vi.mock('./errorReporting', () => ({
  reportClientError: (...args) => reportClientErrorMock(...args),
}))

import { triggerScanNow } from './useScanStatusPoll.js'

describe('triggerScanNow', () => {
  const realFetch = global.fetch

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    global.fetch = realFetch
  })

  it('returns true and does not report when the first request succeeds', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    const result = await triggerScanNow('token-123')
    expect(result).toBe(true)
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(global.fetch).toHaveBeenCalledWith('/.netlify/functions/scan-now-background', {
      method: 'POST',
      headers: { Authorization: 'Bearer token-123' },
    })
    expect(reportClientErrorMock).not.toHaveBeenCalled()
  })

  it('retries once on a non-OK response and returns true if the retry succeeds', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 })
    const result = await triggerScanNow('token-123')
    expect(result).toBe(true)
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(reportClientErrorMock).not.toHaveBeenCalled()
  })

  it('reports and returns false when both attempts come back non-OK', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 429 })
    const result = await triggerScanNow('token-123')
    expect(result).toBe(false)
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(reportClientErrorMock).toHaveBeenCalledWith(
      'scan trigger failed with HTTP 429',
      null,
      { stage: 'trigger-scan-now' },
    )
  })

  it('reports and returns false when fetch itself throws (network-level failure)', async () => {
    const err = new Error('network down')
    global.fetch = vi.fn().mockRejectedValue(err)
    const result = await triggerScanNow('token-123')
    expect(result).toBe(false)
    expect(reportClientErrorMock).toHaveBeenCalledWith('scan trigger failed', err, { stage: 'trigger-scan-now' })
  })
})
