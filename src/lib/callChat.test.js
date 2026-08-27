import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }))
vi.mock('./supabase', () => ({ supabase: { auth: { getSession: getSessionMock } } }))

import { callChat } from './callChat.js'

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('callChat', () => {
  it('throws without calling fetch when there is no signed-in session', async () => {
    getSessionMock.mockResolvedValue({ data: { session: null } })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(callChat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow('You need to be signed in for that.')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('calls the custom /api/chat path (not the default Netlify functions alias) with a bearer token and the full payload', async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'tok_abc' } } })
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ text: 'hello', citations: [] }) })
    vi.stubGlobal('fetch', fetchSpy)

    const result = await callChat({ messages: [{ role: 'user', content: 'hi' }], systemOverride: 'sys', maxTokens: 100, model: 'claude', webSearch: true, maxSearchUses: 2 })

    expect(fetchSpy).toHaveBeenCalledWith('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok_abc' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
        systemOverride: 'sys',
        maxTokens: 100,
        model: 'claude',
        webSearch: true,
        maxSearchUses: 2,
      }),
    })
    expect(result).toEqual({ text: 'hello', citations: [] })
  })

  it('throws the server-provided error message when the response is not ok', async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'tok_abc' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'rate limited' }) }))
    await expect(callChat({ messages: [] })).rejects.toThrow('rate limited')
  })

  it('falls back to a generic error when the failed response body cannot be parsed as JSON', async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'tok_abc' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => { throw new Error('not json') } }))
    await expect(callChat({ messages: [] })).rejects.toThrow('Request failed')
  })

  it('works with no arguments at all (every field optional)', async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'tok_abc' } } })
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ text: 'hi' }) })
    vi.stubGlobal('fetch', fetchSpy)
    await callChat()
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body).toEqual({ messages: undefined, systemOverride: undefined, maxTokens: undefined, model: undefined, webSearch: undefined, maxSearchUses: undefined })
  })

  // 2026-08-27: a request landing in the split-second Netlify swaps one
  // deploy's functions for the next throws at the network layer (fetch()
  // itself rejects, no response ever comes back) — this is the one class
  // of failure worth one silent retry, since a beat later the new function
  // is almost always warm. See callChat.js's own header for why this is
  // deliberately narrower than retrying a real, resolved error response.
  it('retries once and succeeds when the first attempt throws a network-level error', async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'tok_abc' } } })
    const fetchSpy = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ text: 'recovered', citations: [] }) })
    vi.stubGlobal('fetch', fetchSpy)

    const result = await callChat({ messages: [{ role: 'user', content: 'hi' }] })

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ text: 'recovered', citations: [] })
  })

  it('gives up after the retry is also a network-level throw, surfacing the original error', async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'tok_abc' } } })
    const fetchSpy = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchSpy)

    await expect(callChat({ messages: [] })).rejects.toThrow('Failed to fetch')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry a resolved-but-not-ok response — a real cap/auth/rate-limit answer is not a network blip', async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'tok_abc' } } })
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'rate limited' }) })
    vi.stubGlobal('fetch', fetchSpy)

    await expect(callChat({ messages: [] })).rejects.toThrow('rate limited')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})
