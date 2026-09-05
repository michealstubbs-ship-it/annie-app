import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetAuthedUser } = vi.hoisted(() => ({ mockGetAuthedUser: vi.fn() }))
const { mockReportServerError } = vi.hoisted(() => ({ mockReportServerError: vi.fn() }))
const { mockGet, mockGetStore } = vi.hoisted(() => {
  const mockGet = vi.fn()
  return { mockGet, mockGetStore: vi.fn(() => ({ get: mockGet })) }
})

vi.mock('../lib/auth.js', () => ({ getAuthedUser: mockGetAuthedUser }))
vi.mock('../lib/reportError.js', () => ({ reportServerError: mockReportServerError }))
vi.mock('@netlify/blobs', () => ({ getStore: mockGetStore }))

function makeRequest() {
  return new Request('https://annie.example/.netlify/functions/scan-status', { method: 'GET' })
}

let handler

beforeEach(async () => {
  vi.clearAllMocks()
  mockGetAuthedUser.mockResolvedValue({ user: { id: 'user_123' }, error: null })
  vi.resetModules()
  ;({ default: handler } = await import('../scan-status.js'))
})

describe('authentication', () => {
  it('returns status "unknown" for an unauthenticated caller, never reading the blob store', async () => {
    mockGetAuthedUser.mockResolvedValue({ user: null, error: 'invalid_session' })
    const res = await handler(makeRequest())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'unknown' })
    expect(mockGet).not.toHaveBeenCalled()
  })
})

describe('status blob handling', () => {
  it('returns "unknown" when no record exists yet for this user', async () => {
    mockGet.mockResolvedValue(null)
    const res = await handler(makeRequest())
    expect(await res.json()).toEqual({ status: 'unknown' })
  })

  it('returns the record verbatim when it is a recent, real status', async () => {
    const record = { status: 'done', reason: 'ok', signalsFound: 3 }
    mockGet.mockResolvedValue(record)
    const res = await handler(makeRequest())
    expect(await res.json()).toEqual(record)
  })

  it('treats a "running" status older than the 24-minute budget as timed out', async () => {
    mockGet.mockResolvedValue({ status: 'running', startedAt: Date.now() - 30 * 60 * 1000 })
    const res = await handler(makeRequest())
    const body = await res.json()
    expect(body.status).toBe('done')
    expect(body.reason).toBe('timed_out')
  })

  it('trusts a "running" status still within the time budget', async () => {
    mockGet.mockResolvedValue({ status: 'running', startedAt: Date.now() - 60 * 1000 })
    const res = await handler(makeRequest())
    const body = await res.json()
    expect(body.status).toBe('running')
  })

  // 2026-08-26 audit fix: the missing/unrecognized-tier fallback used to be a
  // separately hardcoded 10-minute constant that only happened to match the
  // then-default tier's own maxWallClockMs — this pins that a record with no
  // `tier` at all times out at exactly the default tier's real ceiling plus the
  // 4-minute margin, not a moment sooner.
  //
  // 2026-09-05: the number moved from 10 to 20 minutes on its own, without this
  // file changing, because the default tier became Solo when Starter was
  // removed. That is the fallback doing its job — it follows the config rather
  // than restating it.
  it('uses solo\'s real maxWallClockMs (plus the 4-minute margin) as the timeout for a record with no tier', async () => {
    const justUnderBudget = 20 * 60 * 1000 + 4 * 60 * 1000 - 1000
    mockGet.mockResolvedValue({ status: 'running', startedAt: Date.now() - justUnderBudget })
    const res = await handler(makeRequest())
    expect((await res.json()).status).toBe('running')

    const justOverBudget = 20 * 60 * 1000 + 4 * 60 * 1000 + 1000
    mockGet.mockResolvedValue({ status: 'running', startedAt: Date.now() - justOverBudget })
    const res2 = await handler(makeRequest())
    const body2 = await res2.json()
    expect(body2.status).toBe('done')
    expect(body2.reason).toBe('timed_out')
  })

  it('reports and returns "unknown" if reading the blob store throws', async () => {
    mockGet.mockRejectedValue(new Error('blob store down'))
    const res = await handler(makeRequest())
    expect(await res.json()).toEqual({ status: 'unknown' })
    expect(mockReportServerError).toHaveBeenCalled()
  })
})
