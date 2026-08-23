// Covers the one function standing between signup and Cloudflare's own
// verdict on whether a token is real — see verify-turnstile.js's own
// comments for why this can't be trusted client-side. Mirrors chat.test.js's
// mocking shape (vi.hoisted + resetModules + a fresh handler import per test).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockReportServerError } = vi.hoisted(() => ({ mockReportServerError: vi.fn() }))
vi.mock('../lib/reportError.js', () => ({ reportServerError: mockReportServerError }))

function makeRequest(body, { method = 'POST' } = {}) {
  return new Request('https://annie.example/.netlify/functions/verify-turnstile', {
    method,
    body: method === 'GET' ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  })
}

let handler

beforeEach(async () => {
  vi.clearAllMocks()
  process.env.TURNSTILE_SECRET_KEY = 'secret_test_key'
  global.fetch = vi.fn()

  vi.resetModules()
  ;({ default: handler } = await import('../verify-turnstile.js'))
})

describe('method and configuration guards', () => {
  it('rejects non-POST methods', async () => {
    const res = await handler(makeRequest(null, { method: 'GET' }))
    expect(res.status).toBe(405)
  })

  it('returns 500 when TURNSTILE_SECRET_KEY is unset, without calling Cloudflare', async () => {
    delete process.env.TURNSTILE_SECRET_KEY
    const res = await handler(makeRequest({ token: 'a-token' }))
    expect(res.status).toBe(500)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('returns 400 on an unparseable body', async () => {
    const res = await handler(makeRequest('not json'))
    expect(res.status).toBe(400)
  })

  it('returns 400 when the token is missing', async () => {
    const res = await handler(makeRequest({}))
    expect(res.status).toBe(400)
    expect(global.fetch).not.toHaveBeenCalled()
  })
})

describe('siteverify handling', () => {
  it('calls Cloudflare with the secret, the token, and the caller IP, and returns success', async () => {
    global.fetch.mockResolvedValue({ json: async () => ({ success: true }) })
    const res = await handler(makeRequest({ token: 'good-token' }), { ip: '203.0.113.5' })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ success: true })

    expect(global.fetch).toHaveBeenCalledTimes(1)
    const [url, opts] = global.fetch.mock.calls[0]
    expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify')
    const sentParams = new URLSearchParams(opts.body)
    expect(sentParams.get('secret')).toBe('secret_test_key')
    expect(sentParams.get('response')).toBe('good-token')
    expect(sentParams.get('remoteip')).toBe('203.0.113.5')
  })

  it('omits remoteip when no context IP is available', async () => {
    global.fetch.mockResolvedValue({ json: async () => ({ success: true }) })
    await handler(makeRequest({ token: 'good-token' }))

    const sentParams = new URLSearchParams(global.fetch.mock.calls[0][1].body)
    expect(sentParams.has('remoteip')).toBe(false)
  })

  it('returns 400 when Cloudflare reports the token invalid', async () => {
    global.fetch.mockResolvedValue({ json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }) })
    const res = await handler(makeRequest({ token: 'bad-token' }))
    expect(res.status).toBe(400)
  })

  it('reports and returns 500 if the Cloudflare call itself throws', async () => {
    global.fetch.mockRejectedValue(new Error('network down'))
    const res = await handler(makeRequest({ token: 'a-token' }))
    expect(res.status).toBe(500)
    expect(mockReportServerError).toHaveBeenCalledWith('verify-turnstile', expect.any(Error))
  })
})
