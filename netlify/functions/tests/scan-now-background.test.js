// scan-now-background.js is a background function (no response body, no
// status code to assert on) whose real value is in its guard clauses — auth,
// config, and the two anti-duplicate-trigger checks the file's own comments
// call out as security-relevant (a retried request within 10 minutes, and a
// replayed session token re-firing this expensive pass indefinitely). The
// actual research pipeline (Apollo/Adzuna discovery, AI prompt building,
// dedup) is scanShared.js's own logic, already covered by scanShared.test.js
// — these tests stop at "did the guard actually stop the expensive work",
// asserted via the scan-status blob (setStatus) each guard writes on its way
// out, since that's the one externally-observable side effect available.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetAuthedUser } = vi.hoisted(() => ({ mockGetAuthedUser: vi.fn() }))
const { mockSetJSON, mockGetStore } = vi.hoisted(() => {
  const mockSetJSON = vi.fn().mockResolvedValue(undefined)
  return { mockSetJSON, mockGetStore: vi.fn(() => ({ setJSON: mockSetJSON })) }
})
const { mockReportServerError } = vi.hoisted(() => ({ mockReportServerError: vi.fn() }))
const { mockCreateClient } = vi.hoisted(() => ({ mockCreateClient: vi.fn() }))

vi.mock('../lib/auth.js', () => ({ getAuthedUser: mockGetAuthedUser }))
vi.mock('@netlify/blobs', () => ({ getStore: mockGetStore }))
vi.mock('../lib/reportError.js', () => ({ reportServerError: mockReportServerError }))
vi.mock('@supabase/supabase-js', () => ({ createClient: mockCreateClient }))

function makeRequest(method = 'POST') {
  return new Request('https://annie.example/.netlify/functions/scan-now-background', { method })
}

// Builds a `.from(table)` mock whose chainable methods all resolve to
// `results[table]` regardless of which filters were chained on first —
// these tests only need to control the ROW SHAPE returned per table, not
// assert on the exact query chain (that's scan-status.js/onboarding-write
// territory, not this file's guard clauses).
function makeSupabase(results) {
  const from = vi.fn((table) => {
    const builder = {}
    const chain = () => builder
    Object.assign(builder, {
      select: vi.fn(chain),
      eq: vi.fn(chain),
      gte: vi.fn(chain),
      limit: vi.fn(chain),
      update: vi.fn(chain),
      single: vi.fn(() => Promise.resolve(results[table] ?? { data: null, error: null })),
      then: (resolve, reject) => Promise.resolve(results[table] ?? { data: null, error: null }).then(resolve, reject),
    })
    return builder
  })
  return { from }
}

let handler

beforeEach(async () => {
  vi.clearAllMocks()
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co'
  process.env.VITE_SUPABASE_ANON_KEY = 'anon_x'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service_role_x'
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test'

  mockGetAuthedUser.mockResolvedValue({ user: { id: 'user_123' }, error: null })
  vi.resetModules()
  ;({ default: handler } = await import('../scan-now-background.js'))
})

describe('method and configuration guards', () => {
  it('does nothing on a non-POST request', async () => {
    await handler(makeRequest('GET'))
    expect(mockGetAuthedUser).not.toHaveBeenCalled()
    expect(mockCreateClient).not.toHaveBeenCalled()
  })

  it('does nothing when required config is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY
    await handler(makeRequest())
    expect(mockGetAuthedUser).not.toHaveBeenCalled()
  })
})

describe('authentication', () => {
  it('never starts the scan (never writes a running status) for an unauthenticated caller', async () => {
    mockGetAuthedUser.mockResolvedValue({ user: null, error: 'invalid_session' })
    mockCreateClient.mockReturnValue(makeSupabase({}))
    await handler(makeRequest())
    expect(mockSetJSON).not.toHaveBeenCalled()
  })
})

describe('anti-duplicate-trigger guards', () => {
  it('skips the scan and marks status done when signals already exist from the last 10 minutes', async () => {
    mockCreateClient.mockReturnValue(makeSupabase({
      intelligence_signals: { data: [{ id: 'sig_1' }], error: null },
    }))
    await handler(makeRequest())
    expect(mockSetJSON).toHaveBeenCalledWith('user_123', expect.objectContaining({ status: 'running' }))
    expect(mockSetJSON).toHaveBeenCalledWith('user_123', expect.objectContaining({ status: 'done', reason: 'recent_signals_exist' }))
    // Never reached the onboarding-row read, since it returned before that.
    expect(mockSetJSON).not.toHaveBeenCalledWith('user_123', expect.objectContaining({ reason: 'no_onboarding' }))
  })

  it('marks status done when there is no onboarding row yet for this user', async () => {
    mockCreateClient.mockReturnValue(makeSupabase({
      intelligence_signals: { data: [], error: null },
      onboarding: { data: null, error: null },
    }))
    await handler(makeRequest())
    expect(mockSetJSON).toHaveBeenCalledWith('user_123', expect.objectContaining({ status: 'done', reason: 'no_onboarding' }))
  })

  it('marks status done with a cooldown reason when the last scan ran too recently', async () => {
    mockCreateClient.mockReturnValue(makeSupabase({
      intelligence_signals: { data: [], error: null },
      onboarding: {
        data: {
          user_id: 'user_123', sectors: ['Tech'], functions: [], locations: ['United Kingdom'], tone: 'professional',
          initial_scan_triggered_at: new Date().toISOString(), // just now — well inside the cooldown window
        },
        error: null,
      },
    }))
    await handler(makeRequest())
    expect(mockSetJSON).toHaveBeenCalledWith('user_123', expect.objectContaining({ status: 'done', reason: 'cooldown', retryAfter: expect.any(String) }))
  })
})
