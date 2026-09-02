// activityPing.js is the throttled frontend caller for touch-activity.js —
// these tests cover: a call with no session never fetches, a real session
// fetches /api/touch-activity with the bearer token, a second call inside
// the throttle window is a no-op, and a failed fetch is caught/reported
// rather than thrown (this must never break the page it's called from).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetSession } = vi.hoisted(() => ({ mockGetSession: vi.fn() }))
const { mockReportClientError } = vi.hoisted(() => ({ mockReportClientError: vi.fn() }))

vi.mock('./supabase', () => ({ supabase: { auth: { getSession: mockGetSession } } }))
vi.mock('./errorReporting', () => ({ reportClientError: mockReportClientError }))

let pingActivity, _resetActivityPingThrottleForTests

beforeEach(async () => {
  vi.clearAllMocks()
  vi.resetModules()
  global.fetch = vi.fn().mockResolvedValue({ ok: true })
  mockGetSession.mockResolvedValue({ data: { session: { access_token: 'tok_123' } } })
  ;({ pingActivity, _resetActivityPingThrottleForTests } = await import('./activityPing.js'))
  _resetActivityPingThrottleForTests()
})

it('does nothing when there is no session/token', async () => {
  mockGetSession.mockResolvedValue({ data: { session: null } })
  await pingActivity()
  expect(global.fetch).not.toHaveBeenCalled()
})

it('posts to /api/touch-activity with the bearer token when a session exists', async () => {
  await pingActivity()
  expect(global.fetch).toHaveBeenCalledWith('/api/touch-activity', {
    method: 'POST',
    headers: { Authorization: 'Bearer tok_123' },
  })
})

it('is a no-op on a second call within the throttle window', async () => {
  await pingActivity()
  await pingActivity()
  expect(global.fetch).toHaveBeenCalledTimes(1)
})

it('reports but never throws when the fetch itself fails', async () => {
  global.fetch.mockRejectedValue(new Error('network down'))
  await expect(pingActivity()).resolves.toBeUndefined()
  expect(mockReportClientError).toHaveBeenCalledWith('Activity ping failed to send', expect.any(Error), {})
})
