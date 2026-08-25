import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockCreateClient, mockGetUser } = vi.hoisted(() => {
  const mockGetUser = vi.fn()
  const mockCreateClient = vi.fn(() => ({ auth: { getUser: mockGetUser } }))
  return { mockCreateClient, mockGetUser }
})
vi.mock('@supabase/supabase-js', () => ({ createClient: mockCreateClient }))

import { extractBearerToken, getAuthedUser, getAuthedClient } from './auth.js'

function makeRequest(headers = {}) {
  return { headers: { get: (name) => headers[name.toLowerCase()] ?? headers[name] ?? null } }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('extractBearerToken', () => {
  it('extracts the token from a well-formed Authorization header', () => {
    const req = makeRequest({ authorization: 'Bearer abc123' })
    expect(extractBearerToken(req)).toBe('abc123')
  })

  it('is case-insensitive on the "Bearer" prefix', () => {
    const req = makeRequest({ authorization: 'bearer abc123' })
    expect(extractBearerToken(req)).toBe('abc123')
  })

  it('trims surrounding whitespace', () => {
    const req = makeRequest({ authorization: 'Bearer   abc123  ' })
    expect(extractBearerToken(req)).toBe('abc123')
  })

  it('returns an empty string when there is no Authorization header at all', () => {
    const req = makeRequest({})
    expect(extractBearerToken(req)).toBe('')
  })
})

describe('getAuthedClient / getAuthedUser — security-critical auth guard', () => {
  it('rejects with missing_token when there is no Authorization header', async () => {
    const req = makeRequest({})
    const result = await getAuthedClient(req, 'https://x.supabase.co', 'anon_key')
    expect(result).toEqual({ client: null, user: null, error: 'missing_token' })
    expect(mockCreateClient).not.toHaveBeenCalled()
  })

  it('rejects with not_configured when supabaseUrl or anonKey is missing, even with a real-looking token', async () => {
    const req = makeRequest({ authorization: 'Bearer real-token' })
    expect(await getAuthedClient(req, null, 'anon_key')).toEqual({ client: null, user: null, error: 'not_configured' })
    expect(await getAuthedClient(req, 'https://x.supabase.co', null)).toEqual({ client: null, user: null, error: 'not_configured' })
    expect(mockCreateClient).not.toHaveBeenCalled()
  })

  it('rejects with invalid_session when Supabase reports an error verifying the token', async () => {
    mockGetUser.mockResolvedValue({ data: null, error: { message: 'jwt expired' } })
    const req = makeRequest({ authorization: 'Bearer expired-token' })
    const result = await getAuthedUser(req, 'https://x.supabase.co', 'anon_key')
    expect(result).toEqual({ user: null, error: 'invalid_session' })
  })

  it('rejects with invalid_session when Supabase returns no user, even without an explicit error', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })
    const req = makeRequest({ authorization: 'Bearer some-token' })
    const result = await getAuthedUser(req, 'https://x.supabase.co', 'anon_key')
    expect(result).toEqual({ user: null, error: 'invalid_session' })
  })

  it('accepts a valid token and returns the verified user', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'jane@acme.com' } }, error: null })
    const req = makeRequest({ authorization: 'Bearer valid-token' })
    const result = await getAuthedUser(req, 'https://x.supabase.co', 'anon_key')
    expect(result).toEqual({ user: { id: 'u1', email: 'jane@acme.com' }, error: null })
  })

  it('builds the Supabase client with the caller\'s own bearer token forwarded on every request, never a service-role key', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null })
    const req = makeRequest({ authorization: 'Bearer valid-token' })
    await getAuthedClient(req, 'https://x.supabase.co', 'anon_key')
    expect(mockCreateClient).toHaveBeenCalledWith('https://x.supabase.co', 'anon_key', expect.objectContaining({
      global: expect.objectContaining({ headers: { Authorization: 'Bearer valid-token' } }),
      auth: { persistSession: false, autoRefreshToken: false },
    }))
  })

  it('verifies the token itself against Supabase (getUser is called with the extracted token)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null })
    const req = makeRequest({ authorization: 'Bearer valid-token' })
    await getAuthedUser(req, 'https://x.supabase.co', 'anon_key')
    expect(mockGetUser).toHaveBeenCalledWith('valid-token')
  })

  it('getAuthedClient returns the token-scoped client itself alongside the user, for callers that reuse it', async () => {
    const fakeClient = { auth: { getUser: mockGetUser } }
    mockCreateClient.mockReturnValue(fakeClient)
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null })
    const req = makeRequest({ authorization: 'Bearer valid-token' })
    const result = await getAuthedClient(req, 'https://x.supabase.co', 'anon_key')
    expect(result.client).toBe(fakeClient)
  })
})
