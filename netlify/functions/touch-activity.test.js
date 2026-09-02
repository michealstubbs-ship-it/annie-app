// touch-activity.js updates the caller's own profiles.last_active_at — these
// tests cover: non-POST rejected before auth, unauthenticated rejected,
// unconfigured environment rejected, a successful call updates only the
// caller's own row (via .eq('id', user.id) on the token-scoped client,
// never a service-role client), and an update failure is reported but
// still returns 200/ok:false (same "never let a best-effort ping look like
// a real error to the customer" posture as every other function here).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetAuthedClient } = vi.hoisted(() => ({ mockGetAuthedClient: vi.fn() }))
const { mockReportServerError } = vi.hoisted(() => ({ mockReportServerError: vi.fn().mockResolvedValue(undefined) }))
const { mockEq, mockUpdate } = vi.hoisted(() => {
  const mockEq = vi.fn().mockResolvedValue({ error: null })
  const mockUpdate = vi.fn(() => ({ eq: mockEq }))
  return { mockEq, mockUpdate }
})

vi.mock('./lib/auth.js', () => ({ getAuthedClient: mockGetAuthedClient }))
vi.mock('./lib/reportError.js', () => ({ reportServerError: mockReportServerError }))

function makeRequest({ method = 'POST' } = {}) {
  return new Request('https://annie.example/api/touch-activity', { method })
}

let handler

beforeEach(async () => {
  vi.clearAllMocks()
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co'
  process.env.VITE_SUPABASE_ANON_KEY = 'anon_x'

  mockEq.mockResolvedValue({ error: null })
  mockUpdate.mockImplementation(() => ({ eq: mockEq }))
  mockGetAuthedClient.mockResolvedValue({
    client: { from: () => ({ update: mockUpdate }) },
    user: { id: 'user_123' },
    error: null,
  })

  vi.resetModules()
  ;({ default: handler } = await import('./touch-activity.js'))
})

it('rejects a non-POST request without touching auth', async () => {
  const resp = await handler(makeRequest({ method: 'GET' }))
  expect(resp.status).toBe(405)
  expect(mockGetAuthedClient).not.toHaveBeenCalled()
})

it('returns 401 when the caller is not authenticated, and never touches the database', async () => {
  mockGetAuthedClient.mockResolvedValue({ client: null, user: null, error: 'invalid_session' })
  const resp = await handler(makeRequest())
  expect(resp.status).toBe(401)
  expect(mockUpdate).not.toHaveBeenCalled()
})

it('returns 500 when Supabase env vars are not configured, without calling getAuthedClient', async () => {
  delete process.env.VITE_SUPABASE_URL
  const resp = await handler(makeRequest())
  expect(resp.status).toBe(500)
  expect(mockGetAuthedClient).not.toHaveBeenCalled()
})

it('updates last_active_at scoped to the caller\'s own id, via the token-scoped client', async () => {
  const resp = await handler(makeRequest())
  expect(resp.status).toBe(200)
  const body = await resp.json()
  expect(body.ok).toBe(true)
  expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ last_active_at: expect.any(String) }))
  expect(mockEq).toHaveBeenCalledWith('id', 'user_123')
})

it('reports but still returns 200/ok:false when the update itself fails', async () => {
  mockEq.mockResolvedValue({ error: { message: 'update denied' } })
  const resp = await handler(makeRequest())
  expect(resp.status).toBe(200)
  const body = await resp.json()
  expect(body.ok).toBe(false)
  expect(mockReportServerError).toHaveBeenCalledWith('touch-activity', expect.any(Error), { userId: 'user_123' })
})
