import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetAuthedUser } = vi.hoisted(() => ({ mockGetAuthedUser: vi.fn() }))
const { mockReportServerError } = vi.hoisted(() => ({ mockReportServerError: vi.fn() }))
const { mockRpc, mockCreateClient } = vi.hoisted(() => {
  const mockRpc = vi.fn()
  return { mockRpc, mockCreateClient: vi.fn(() => ({ rpc: mockRpc })) }
})

vi.mock('../lib/auth.js', () => ({ getAuthedUser: mockGetAuthedUser }))
vi.mock('../lib/reportError.js', () => ({ reportServerError: mockReportServerError }))
vi.mock('@supabase/supabase-js', () => ({ createClient: mockCreateClient }))

function makeRequest(body, { method = 'POST' } = {}) {
  return new Request('https://annie.example/.netlify/functions/confirm-contact', {
    method,
    body: method === 'GET' ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  })
}

let handler

beforeEach(async () => {
  vi.clearAllMocks()
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co'
  process.env.VITE_SUPABASE_ANON_KEY = 'anon_x'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service_role_x'
  mockGetAuthedUser.mockResolvedValue({ user: { id: 'user_123' }, error: null })
  mockRpc.mockResolvedValue({ error: null })
  vi.resetModules()
  ;({ default: handler } = await import('../confirm-contact.js'))
})

describe('method and configuration guards', () => {
  it('rejects non-POST methods', async () => {
    const res = await handler(makeRequest(null, { method: 'GET' }))
    expect(res.status).toBe(405)
  })

  it('returns 500 when required config is missing', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    const res = await handler(makeRequest({ company: 'Acme' }))
    expect(res.status).toBe(500)
  })
})

describe('request body validation', () => {
  it('returns 400 on an unparseable body', async () => {
    const res = await handler(makeRequest('not json'))
    expect(res.status).toBe(400)
  })

  it('returns 400 when company is missing', async () => {
    const res = await handler(makeRequest({}))
    expect(res.status).toBe(400)
  })
})

describe('authentication', () => {
  it('returns 401 for an unauthenticated caller', async () => {
    mockGetAuthedUser.mockResolvedValue({ user: null, error: 'invalid_session' })
    const res = await handler(makeRequest({ company: 'Acme' }))
    expect(res.status).toBe(401)
    expect(mockRpc).not.toHaveBeenCalled()
  })
})

describe('confirmation RPC', () => {
  it('calls bump_contact_confirmation with normalized keys and returns success', async () => {
    const res = await handler(makeRequest({ company: 'Acme Ltd', titleKeywords: ['Engineer'] }))
    expect(res.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith('bump_contact_confirmation', expect.objectContaining({
      p_company_key: expect.any(String),
      p_title_key: expect.any(String),
    }))
    const body = await res.json()
    expect(body).toEqual({ success: true })
  })

  it('reports and returns 400 when the RPC itself reports an error', async () => {
    mockRpc.mockResolvedValue({ error: { message: 'bad key' } })
    const res = await handler(makeRequest({ company: 'Acme' }))
    expect(res.status).toBe(400)
    expect(mockReportServerError).toHaveBeenCalled()
  })

  it('reports and returns 500 when the RPC call throws', async () => {
    mockRpc.mockRejectedValue(new Error('network down'))
    const res = await handler(makeRequest({ company: 'Acme' }))
    expect(res.status).toBe(500)
    expect(mockReportServerError).toHaveBeenCalled()
  })
})
