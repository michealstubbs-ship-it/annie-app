import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetAuthedClient } = vi.hoisted(() => ({ mockGetAuthedClient: vi.fn() }))
const { mockReportServerError } = vi.hoisted(() => ({ mockReportServerError: vi.fn() }))
const { mockSendWelcomeEmail } = vi.hoisted(() => ({ mockSendWelcomeEmail: vi.fn() }))
const { mockUpsert, mockEq, mockUpdate, mockFrom } = vi.hoisted(() => {
  const mockUpsert = vi.fn()
  const mockEq = vi.fn()
  const mockUpdate = vi.fn(() => ({ eq: mockEq }))
  const mockFrom = vi.fn(() => ({ upsert: mockUpsert, update: mockUpdate }))
  return { mockUpsert, mockEq, mockUpdate, mockFrom }
})

vi.mock('../lib/auth.js', () => ({ getAuthedClient: mockGetAuthedClient }))
vi.mock('../lib/reportError.js', () => ({ reportServerError: mockReportServerError }))
vi.mock('../lib/email.js', () => ({ sendWelcomeEmail: mockSendWelcomeEmail }))

function makeRequest(body, { method = 'POST' } = {}) {
  return new Request('https://annie.example/.netlify/functions/save-onboarding', {
    method,
    body: method === 'GET' ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  })
}

const validBody = { firmName: 'Acme Search', sectors: ['Tech'], functions: ['Engineering'], locations: ['London'], tone: 'professional' }

let handler

beforeEach(async () => {
  vi.clearAllMocks()
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co'
  process.env.VITE_SUPABASE_ANON_KEY = 'anon_x'

  mockGetAuthedClient.mockResolvedValue({ client: { from: mockFrom }, user: { id: 'user_123', email: 'a@b.com' }, error: null })
  mockUpsert.mockResolvedValue({ error: null })
  mockEq.mockResolvedValue({ error: null })
  mockSendWelcomeEmail.mockResolvedValue(true)

  vi.resetModules()
  ;({ default: handler } = await import('../save-onboarding.js'))
})

describe('method guard', () => {
  it('rejects non-POST methods', async () => {
    const res = await handler(makeRequest(null, { method: 'GET' }))
    expect(res.status).toBe(405)
  })
})

describe('request body validation', () => {
  it('returns 400 on an unparseable body', async () => {
    const res = await handler(makeRequest('not json'))
    expect(res.status).toBe(400)
  })

  it('returns 400 when sectors/functions/locations are not arrays', async () => {
    const res = await handler(makeRequest({ firmName: 'Acme', sectors: 'Tech', functions: [], locations: [] }))
    expect(res.status).toBe(400)
    expect(mockGetAuthedClient).not.toHaveBeenCalled()
  })

  it('returns 400 when a list exceeds the 20-item cap', async () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => `item ${i}`)
    const res = await handler(makeRequest({ ...validBody, sectors: tooMany }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/at most 20 items/)
  })

  it('returns 400 when an item exceeds the 100-character cap', async () => {
    const res = await handler(makeRequest({ ...validBody, locations: ['x'.repeat(101)] }))
    expect(res.status).toBe(400)
  })
})

describe('configuration guard', () => {
  it('returns 500 when Supabase env vars are missing', async () => {
    delete process.env.VITE_SUPABASE_URL
    const res = await handler(makeRequest(validBody))
    expect(res.status).toBe(500)
  })
})

describe('authentication', () => {
  it('returns 401 when the session token is missing', async () => {
    mockGetAuthedClient.mockResolvedValue({ client: null, user: null, error: 'missing_token' })
    const res = await handler(makeRequest(validBody))
    expect(res.status).toBe(401)
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it('returns 401 for an invalid session', async () => {
    mockGetAuthedClient.mockResolvedValue({ client: null, user: null, error: 'invalid_session' })
    const res = await handler(makeRequest(validBody))
    expect(res.status).toBe(401)
  })

  it('returns 500 for any other auth error (e.g. not_configured)', async () => {
    mockGetAuthedClient.mockResolvedValue({ client: null, user: null, error: 'not_configured' })
    const res = await handler(makeRequest(validBody))
    expect(res.status).toBe(500)
  })
})

describe('save flow', () => {
  it('returns 400 and reports the error when the onboarding upsert fails', async () => {
    mockUpsert.mockResolvedValue({ error: { message: 'upsert failed' } })
    const res = await handler(makeRequest(validBody))
    expect(res.status).toBe(400)
    expect(mockReportServerError).toHaveBeenCalledWith('save-onboarding', expect.anything(), expect.objectContaining({ stage: 'onboarding-upsert' }))
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('returns 400 and reports the error when the profile update fails', async () => {
    mockEq.mockResolvedValue({ error: { message: 'profile update failed' } })
    const res = await handler(makeRequest(validBody))
    expect(res.status).toBe(400)
    expect(mockReportServerError).toHaveBeenCalledWith('save-onboarding', expect.anything(), expect.objectContaining({ stage: 'profile-update' }))
  })

  it('saves onboarding, updates the profile, sends the welcome email, and returns success', async () => {
    const res = await handler(makeRequest(validBody))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'user_123', firm_name: 'Acme Search', sectors: ['Tech'] }),
      expect.objectContaining({ onConflict: 'user_id' })
    )
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ onboarding_completed: true }))
    expect(mockEq).toHaveBeenCalledWith('id', 'user_123')
    expect(mockSendWelcomeEmail).toHaveBeenCalledWith('a@b.com', 'Acme Search')
  })
})
