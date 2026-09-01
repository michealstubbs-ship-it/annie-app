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

  // 2026-09-01: chat.js reports the caller's monthly Ask Annie usage in
  // response headers so Chat.jsx can warn a Starter recruiter before they hit
  // the ceiling rather than letting them walk into a 402 mid-call-prep.
  describe('monthly usage headers', () => {
    it('returns the used/limit/remaining triple when the server sends the headers', async () => {
      getSessionMock.mockResolvedValue({ data: { session: { access_token: 'tok_abc' } } })
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        headers: new Headers({ 'X-Annie-Chat-Used': '412', 'X-Annie-Chat-Limit': '500' }),
        json: async () => ({ text: 'hello', citations: [] }),
      })

      const result = await callChat({ messages: [{ role: 'user', content: 'hi' }] })

      expect(result.usage).toEqual({ used: 412, limit: 500, remaining: 88 })
    })

    it('omits usage entirely on an unlimited plan, so the shape is unchanged', async () => {
      // Growth/Team deliberately get no headers — a recruiter on an uncapped
      // plan should never see a countdown implying a limit exists.
      getSessionMock.mockResolvedValue({ data: { session: { access_token: 'tok_abc' } } })
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => ({ text: 'hello', citations: [] }),
      })

      const result = await callChat({ messages: [{ role: 'user', content: 'hi' }] })

      expect(result).toEqual({ text: 'hello', citations: [] })
      expect('usage' in result).toBe(false)
    })

    it('never lets a malformed or missing header break the reply', async () => {
      // A usage counter is a nicety; the answer is the product. A proxy that
      // strips headers, or an older deploy that does not send them yet, must
      // degrade to "no counter" rather than throwing.
      getSessionMock.mockResolvedValue({ data: { session: { access_token: 'tok_abc' } } })
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        headers: new Headers({ 'X-Annie-Chat-Used': 'not-a-number', 'X-Annie-Chat-Limit': '0' }),
        json: async () => ({ text: 'hello', citations: [] }),
      })

      const result = await callChat({ messages: [{ role: 'user', content: 'hi' }] })

      expect(result).toEqual({ text: 'hello', citations: [] })
    })
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

  // 2026-08-29 audit fix, flagged directly: a thrown fetch used to be
  // retried unconditionally, with no regard for how long the failed attempt
  // actually ran. A request that took most of chat.js's own execution
  // ceiling before finally throwing was never going to succeed a second
  // time either — retrying it just makes the caller wait through the same
  // doomed delay twice. Only a FAST throw (the deploy-swap blip this retry
  // was built for) is retried; a slow one is surfaced immediately.
  it('does NOT retry a throw that took a while to happen — a slow, doomed request is not a fast blip', async () => {
    vi.useFakeTimers()
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'tok_abc' } } })
    const fetchSpy = vi.fn().mockImplementation(() => new Promise((_, reject) => {
      setTimeout(() => reject(new TypeError('Failed to fetch')), 5000) // well past FAST_FAILURE_MS
    }))
    vi.stubGlobal('fetch', fetchSpy)

    const promise = callChat({ messages: [] })
    const assertion = expect(promise).rejects.toThrow('Failed to fetch')
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('does NOT retry a resolved-but-not-ok response — a real cap/auth/rate-limit answer is not a network blip', async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'tok_abc' } } })
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'rate limited' }) })
    vi.stubGlobal('fetch', fetchSpy)

    await expect(callChat({ messages: [] })).rejects.toThrow('rate limited')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  // 2026-08-29: getSession() has no timeout of its own and can simply never
  // settle (auth still starting up, a browser extension/corporate proxy
  // interfering) rather than reject — this was the root cause of Today's
  // Actions' reported hang. Every caller now races it against a real
  // timeout instead of waiting forever with nothing to show.
  it('rejects with a clear timeout error instead of hanging forever when getSession() never settles', async () => {
    vi.useFakeTimers()
    getSessionMock.mockReturnValue(new Promise(() => {})) // never resolves
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const promise = callChat({ messages: [{ role: 'user', content: 'hi' }] })
    const assertion = expect(promise).rejects.toThrow('TIMEOUT:callChat-session')
    await vi.advanceTimersByTimeAsync(8000)
    await assertion
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})
