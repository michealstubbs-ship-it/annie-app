// intelligence-scan.js is now just the `schedule` trigger — its only job is
// firing intelligence-scan-background.js over HTTP (that file carries the
// real research pipeline and its own test coverage). Same retry-then-report
// shape and same reasoning as scan-now-background.js's fireNextRound tests:
// tested directly against a mocked global.fetch rather than the handler,
// since reaching this via the handler would mean also standing up Supabase
// mocks this file no longer needs.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockReportServerError } = vi.hoisted(() => ({ mockReportServerError: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/reportError.js', () => ({ reportServerError: mockReportServerError }))

function makeRequest(method = 'POST') {
  return new Request('https://annie.example/.netlify/functions/intelligence-scan', { method })
}

describe('method guard', () => {
  let handler
  beforeEach(async () => {
    vi.clearAllMocks()
    process.env.INTERNAL_SCAN_SECRET = 'test-internal-secret'
    process.env.URL = 'https://annie.example'
    vi.resetModules()
    ;({ default: handler } = await import('../intelligence-scan.js'))
  })
  afterEach(() => {
    delete process.env.INTERNAL_SCAN_SECRET
    delete process.env.URL
  })

  it('rejects non-POST methods without firing the background scan', async () => {
    global.fetch = vi.fn()
    const res = await handler(makeRequest('GET'))
    expect(res.status).toBe(405)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('fires intelligence-scan-background with the internal secret header and returns 200', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 202 })
    const res = await handler(makeRequest())
    expect(res.status).toBe(200)
    expect(global.fetch).toHaveBeenCalledWith(
      'https://annie.example/.netlify/functions/intelligence-scan-background',
      expect.objectContaining({ method: 'POST', headers: { 'x-internal-scan-secret': 'test-internal-secret' } })
    )
  })
})

describe('fireBackgroundScan (trigger-fire retry)', () => {
  let fireBackgroundScan
  const realFetch = global.fetch

  beforeEach(async () => {
    vi.clearAllMocks()
    process.env.INTERNAL_SCAN_SECRET = 'test-internal-secret'
    process.env.URL = 'https://annie.example'
    vi.resetModules()
    ;({ fireBackgroundScan } = await import('../intelligence-scan.js'))
  })

  afterEach(() => {
    global.fetch = realFetch
    delete process.env.INTERNAL_SCAN_SECRET
    delete process.env.URL
  })

  it('does not retry or report when the fire succeeds', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 202 })
    await fireBackgroundScan()
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(mockReportServerError).not.toHaveBeenCalled()
  })

  it('retries once and succeeds silently when the retry is OK', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce({ ok: true, status: 202 })
    await fireBackgroundScan()
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(mockReportServerError).not.toHaveBeenCalled()
  })

  it('reports a server error only after both the original call and the retry come back non-OK', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: false, status: 503 })
    await fireBackgroundScan()
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(mockReportServerError).toHaveBeenCalledTimes(1)
    expect(mockReportServerError).toHaveBeenCalledWith(
      'intelligence-scan',
      expect.any(Error),
      expect.objectContaining({ stage: 'trigger-fire' })
    )
  })

  it('reports a server error when the fetch itself throws (network failure)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network down'))
    await fireBackgroundScan()
    expect(mockReportServerError).toHaveBeenCalledTimes(1)
    expect(mockReportServerError).toHaveBeenCalledWith(
      'intelligence-scan',
      expect.any(Error),
      expect.objectContaining({ stage: 'trigger-fire' })
    )
  })

  it('reports a server error and never calls fetch when INTERNAL_SCAN_SECRET is not configured', async () => {
    delete process.env.INTERNAL_SCAN_SECRET
    vi.resetModules()
    ;({ fireBackgroundScan } = await import('../intelligence-scan.js'))
    global.fetch = vi.fn()
    await fireBackgroundScan()
    expect(global.fetch).not.toHaveBeenCalled()
    expect(mockReportServerError).toHaveBeenCalledTimes(1)
  })
})
