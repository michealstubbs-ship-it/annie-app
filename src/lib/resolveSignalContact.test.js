import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }))
vi.mock('./supabase', () => ({ supabase: { auth: { getSession: getSessionMock } } }))

import { resolveSignalContact } from './resolveSignalContact.js'

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('resolveSignalContact', () => {
  // 2026-09-02 audit fix, real report ("Product & Engineering is still
  // broken" led to auditing every /.netlify/functions/ caller): this
  // function declares config.path = '/api/resolve-signal-contact', which
  // means only that path resolves — not the default
  // '/.netlify/functions/resolve-signal-contact' alias. Calling the
  // wrong path silently degraded every call to { found: false }.
  it('posts to /api/resolve-signal-contact with the caller\'s bearer token and signalId', async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'tok_abc' } } })
    const fetchSpy = vi.fn().mockResolvedValue({ json: async () => ({ found: true, contact: { name: 'Jane Doe' } }) })
    vi.stubGlobal('fetch', fetchSpy)

    const result = await resolveSignalContact('sig_1')

    expect(fetchSpy).toHaveBeenCalledWith('/api/resolve-signal-contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok_abc' },
      body: JSON.stringify({ signalId: 'sig_1' }),
    })
    expect(result).toEqual({ found: true, contact: { name: 'Jane Doe' } })
  })

  it('returns found:false with a clear message when there is no active session', async () => {
    getSessionMock.mockResolvedValue({ data: { session: null } })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await resolveSignalContact('sig_1')

    expect(result).toEqual({ found: false, error: 'Your session has expired. Please log in again.' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns found:false instead of throwing when the request itself fails', async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'tok_abc' } } })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

    const result = await resolveSignalContact('sig_1')

    expect(result).toEqual({ found: false, error: 'network down' })
  })

  it('returns found:false instead of throwing when getSession itself rejects', async () => {
    getSessionMock.mockRejectedValue(new Error('TIMEOUT:resolve-signal-contact-session'))
    const result = await resolveSignalContact('sig_1')
    expect(result).toEqual({ found: false, error: 'TIMEOUT:resolve-signal-contact-session' })
  })
})
