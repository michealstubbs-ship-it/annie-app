// admin-feature-adoption.js reads real usage from PostHog (see that file's
// own header for why it can't be a Postgres RPC) — these tests cover: the
// same method/auth/is_admin guards every other admin-JS-endpoint uses,
// "not configured" (no PostHog personal API key) returns 200/configured:
// false rather than an error, a configured call queries both PostHog
// endpoints and shapes the two result sets correctly by column name (not
// position), an unrecognized path/event from PostHog is silently dropped
// rather than shown with a blank label, and a PostHog fetch failure is
// reported but still returns 200 with empty arrays (never blanks the
// whole Overview tab the way throwing would).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetAuthedUser } = vi.hoisted(() => ({ mockGetAuthedUser: vi.fn() }))
const { mockReportServerError } = vi.hoisted(() => ({ mockReportServerError: vi.fn() }))
const { mockProfileSelect, mockCreateClient } = vi.hoisted(() => {
  const mockProfileSelect = vi.fn()
  const mockCreateClient = vi.fn(() => ({
    from: vi.fn((table) => {
      if (table === 'profiles') {
        return { select: () => ({ eq: () => ({ maybeSingle: mockProfileSelect }) }) }
      }
      throw new Error(`unexpected table ${table}`)
    }),
  }))
  return { mockProfileSelect, mockCreateClient }
})

vi.mock('../lib/auth.js', () => ({ getAuthedUser: mockGetAuthedUser }))
vi.mock('../lib/reportError.js', () => ({ reportServerError: mockReportServerError }))
vi.mock('@supabase/supabase-js', () => ({ createClient: mockCreateClient }))

function makeRequest({ method = 'GET' } = {}) {
  return new Request('https://annie.example/api/admin-feature-adoption', { method })
}

function posthogResponse(columns, rows) {
  return { ok: true, json: () => Promise.resolve({ columns, results: rows }) }
}

let handler

beforeEach(async () => {
  vi.clearAllMocks()
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co'
  process.env.VITE_SUPABASE_ANON_KEY = 'anon_x'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service_role_x'
  delete process.env.POSTHOG_PERSONAL_API_KEY
  delete process.env.POSTHOG_PROJECT_ID
    process.env.VITE_POSTHOG_HOST = 'https://us.i.posthog.com'
  

  mockGetAuthedUser.mockResolvedValue({ user: { id: 'user_admin' }, error: null })
  mockProfileSelect.mockResolvedValue({ data: { is_admin: true }, error: null })
  global.fetch = vi.fn()

  vi.resetModules()
  ;({ default: handler } = await import('../admin-feature-adoption.js'))
})

describe('method and auth guards', () => {
  it('rejects non-GET methods', async () => {
    const res = await handler(makeRequest({ method: 'POST' }))
    expect(res.status).toBe(405)
  })

  it('returns 401 for an unauthenticated caller, never touching the profiles table', async () => {
    mockGetAuthedUser.mockResolvedValue({ user: null, error: 'invalid_session' })
    const res = await handler(makeRequest())
    expect(res.status).toBe(401)
    expect(mockProfileSelect).not.toHaveBeenCalled()
  })

  it('returns 403 for an authenticated caller who is not an admin', async () => {
    mockProfileSelect.mockResolvedValue({ data: { is_admin: false }, error: null })
    const res = await handler(makeRequest())
    expect(res.status).toBe(403)
  })
})

describe('not configured', () => {
  it('returns 200/configured:false without calling PostHog when the personal API key is missing', async () => {
    process.env.POSTHOG_PROJECT_ID = '12345'
    const res = await handler(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ configured: false })
    expect(global.fetch).not.toHaveBeenCalled()
  })
})

describe('configured, real data', () => {
  beforeEach(() => {
    process.env.POSTHOG_PERSONAL_API_KEY = 'phx_personal_key'
    process.env.POSTHOG_PROJECT_ID = '12345'
  })

  it('queries both PostHog endpoints and returns pages/events shaped by column name', async () => {
    global.fetch
      .mockResolvedValueOnce(posthogResponse(
        ['path', 'events_7d', 'users_7d', 'events_30d', 'users_30d'],
        [['/dashboard/actions', 40, 8, 150, 12], ['/dashboard/chat', 20, 5, 80, 9]],
      ))
      .mockResolvedValueOnce(posthogResponse(
        ['event', 'events_7d', 'users_7d', 'events_30d', 'users_30d'],
        [['ask_annie_message_sent', 30, 6, 100, 10]],
      ))

    const res = await handler(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.configured).toBe(true)
    expect(body.pages).toEqual([
      { path: '/dashboard/actions', label: "Today's Actions", usersLast7d: 8, usersLast30d: 12, eventsLast7d: 40, eventsLast30d: 150 },
      { path: '/dashboard/chat', label: 'Ask Annie', usersLast7d: 5, usersLast30d: 9, eventsLast7d: 20, eventsLast30d: 80 },
    ])
    expect(body.events).toEqual([
      { name: 'ask_annie_message_sent', label: 'Ask Annie message sent', usersLast7d: 6, usersLast30d: 10, eventsLast7d: 30, eventsLast30d: 100 },
    ])
  })

  it('sends the personal API key as a bearer token to the project-scoped query endpoint', async () => {
    global.fetch.mockResolvedValue(posthogResponse(['path', 'events_7d', 'users_7d', 'events_30d', 'users_30d'], []))
    await handler(makeRequest())
    const [url, opts] = global.fetch.mock.calls[0]
    expect(url).toBe('https://us.i.posthog.com/api/projects/12345/query/')
    expect(opts.headers.Authorization).toBe('Bearer phx_personal_key')
  })

  it('silently drops a path/event PostHog returns that is not in the known label maps', async () => {
    global.fetch
      .mockResolvedValueOnce(posthogResponse(
        ['path', 'events_7d', 'users_7d', 'events_30d', 'users_30d'],
        [['/some/unmapped/route', 5, 2, 5, 2]],
      ))
      .mockResolvedValueOnce(posthogResponse(['event', 'events_7d', 'users_7d', 'events_30d', 'users_30d'], []))

    const res = await handler(makeRequest())
    const body = await res.json()
    expect(body.pages).toEqual([])
  })

  it('reports but still returns 200 with empty arrays when the PostHog fetch fails', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 500 })
    const res = await handler(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ configured: true, pages: [], events: [], error: 'fetch_failed' })
    expect(mockReportServerError).toHaveBeenCalledWith('admin-feature-adoption', expect.any(Error), { userId: 'user_admin' })
  })
})
