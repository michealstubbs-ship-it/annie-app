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

  it('treats a "running" status older than the 14-minute budget as timed out', async () => {
    mockGet.mockResolvedValue({ status: 'running', startedAt: Date.now() - 15 * 60 * 1000 })
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

  it('reports and returns "unknown" if reading the blob store throws', async () => {
    mockGet.mockRejectedValue(new Error('blob store down'))
    const res = await handler(makeRequest())
    expect(await res.json()).toEqual({ status: 'unknown' })
    expect(mockReportServerError).toHaveBeenCalled()
  })
})
