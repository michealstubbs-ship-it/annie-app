// chat.js had zero test coverage before this file — every guard clause
// (auth, config, rate/token caps) and, critically, the Anthropic-failure
// branch were only ever checked by hand via curl against production. That's
// exactly how the 2026-08-23 intermittent chat failures went unexplained
// for as long as they did: the branch that swallowed Anthropic's own
// transient errors without logging them was never exercised by anything,
// so nothing would have caught it going quiet again either. These tests
// cover: every early-return guard, the retry-once-on-transient-status
// behavior, and — the actual regression target — that an Anthropic failure
// now always reaches reportServerError with the status attached before the
// error response is returned to the caller.
//
// Lives in tests/, same as scan-now-background.test.js, not directly in
// netlify/functions/ — Netlify's function bundler scans every top-level
// file in that folder as a function candidate, and a file with a "." in
// its stem (chat.test.js -> "chat.test") fails Netlify's function-name
// validation and takes the whole production build down with it. Found this
// the hard way: it broke exactly this way on first deploy.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetAuthedUser } = vi.hoisted(() => ({ mockGetAuthedUser: vi.fn() }))
const { mockReserveAnthropicTokens, mockReserveChatCall } = vi.hoisted(() => ({
  mockReserveAnthropicTokens: vi.fn().mockResolvedValue(true),
  mockReserveChatCall: vi.fn().mockResolvedValue(true),
}))
const { mockReportServerError } = vi.hoisted(() => ({ mockReportServerError: vi.fn().mockResolvedValue(undefined) }))
const { mockCreateClient } = vi.hoisted(() => ({ mockCreateClient: vi.fn(() => ({})) }))

vi.mock('../lib/auth.js', () => ({ getAuthedUser: mockGetAuthedUser }))
vi.mock('../lib/aiUsage.js', () => ({
  reserveAnthropicTokens: mockReserveAnthropicTokens,
  reserveChatCall: mockReserveChatCall,
}))
vi.mock('../lib/reportError.js', () => ({ reportServerError: mockReportServerError }))
vi.mock('@supabase/supabase-js', () => ({ createClient: mockCreateClient }))

function makeRequest(body, { method = 'POST', invalidJson = false } = {}) {
  const init = { method }
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = invalidJson ? '{not json' : JSON.stringify(body ?? { messages: [{ role: 'user', content: 'hi' }] })
  }
  return new Request('https://annie.example/api/chat', init)
}

function anthropicOkResponse(text = 'hello there') {
  return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status: 200 })
}

function anthropicErrorResponse(status, body = 'upstream error') {
  return new Response(body, { status })
}

let handler

beforeEach(async () => {
  vi.clearAllMocks()
  vi.useRealTimers()
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co'
  process.env.VITE_SUPABASE_ANON_KEY = 'anon_x'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service_role_x'
  delete process.env.CHAT_PER_MINUTE_CAP
  delete process.env.ANTHROPIC_DAILY_TOKEN_CAP

  mockGetAuthedUser.mockResolvedValue({ user: { id: 'user_123' }, error: null })
  mockReserveChatCall.mockResolvedValue(true)
  mockReserveAnthropicTokens.mockResolvedValue(true)

  global.fetch = vi.fn().mockResolvedValue(anthropicOkResponse())

  vi.resetModules()
  ;({ default: handler } = await import('../chat.js'))
})

describe('method and configuration guards', () => {
  it('rejects a non-POST request without touching auth or Anthropic', async () => {
    const resp = await handler(makeRequest(undefined, { method: 'GET' }))
    expect(resp.status).toBe(405)
    expect(mockGetAuthedUser).not.toHaveBeenCalled()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('returns 500 when required config is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const resp = await handler(makeRequest())
    expect(resp.status).toBe(500)
    expect(mockGetAuthedUser).not.toHaveBeenCalled()
  })
})

describe('auth and rate/budget guards', () => {
  it('returns 401 when the caller is not authenticated, before any Anthropic call', async () => {
    mockGetAuthedUser.mockResolvedValue({ user: null, error: 'invalid_session' })
    const resp = await handler(makeRequest())
    expect(resp.status).toBe(401)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('returns 429 and never calls Anthropic when the per-minute cap is hit', async () => {
    mockReserveChatCall.mockResolvedValue(false)
    const resp = await handler(makeRequest())
    expect(resp.status).toBe(429)
    expect(global.fetch).not.toHaveBeenCalled()
    expect(mockReserveAnthropicTokens).not.toHaveBeenCalled()
  })

  it('returns 429 and never calls Anthropic when the daily token cap is hit', async () => {
    mockReserveAnthropicTokens.mockResolvedValue(false)
    const resp = await handler(makeRequest())
    expect(resp.status).toBe(429)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('returns 400 on an unparseable request body, without reporting it as a server error', async () => {
    const resp = await handler(makeRequest(undefined, { invalidJson: true }))
    expect(resp.status).toBe(400)
    expect(mockReportServerError).not.toHaveBeenCalled()
  })
})

describe('the successful path', () => {
  it('returns the assistant text and never reports an error', async () => {
    const resp = await handler(makeRequest())
    expect(resp.status).toBe(200)
    const body = await resp.json()
    expect(body.text).toBe('hello there')
    expect(mockReportServerError).not.toHaveBeenCalled()
  })
})

describe('Anthropic failures — the 2026-08-23 regression target', () => {
  it('logs a non-transient failure via reportServerError with the status attached, and returns that status to the caller', async () => {
    global.fetch.mockResolvedValue(anthropicErrorResponse(400, 'bad request shape'))
    const resp = await handler(makeRequest())
    expect(resp.status).toBe(400)
    expect(global.fetch).toHaveBeenCalledTimes(1) // non-transient status, no retry
    expect(mockReportServerError).toHaveBeenCalledWith(
      'chat',
      expect.objectContaining({ message: expect.stringContaining('Anthropic 400') }),
      { status: 400 }
    )
  })

  it('retries once on a transient 429, and succeeds without ever reporting an error if the retry works', async () => {
    vi.useFakeTimers()
    global.fetch
      .mockResolvedValueOnce(anthropicErrorResponse(429, 'rate limited'))
      .mockResolvedValueOnce(anthropicOkResponse('recovered on retry'))

    const pending = handler(makeRequest())
    await vi.advanceTimersByTimeAsync(500)
    const resp = await pending

    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(resp.status).toBe(200)
    const body = await resp.json()
    expect(body.text).toBe('recovered on retry')
    expect(mockReportServerError).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('retries once on a transient 529, and reports the error if it fails again', async () => {
    vi.useFakeTimers()
    // A fresh Response per call — reusing one mocked Response across both
    // attempts would fail on the retry's own .text() read (a Response body
    // can only be consumed once), for reasons that have nothing to do with
    // the retry logic actually under test here.
    global.fetch.mockImplementation(() => Promise.resolve(anthropicErrorResponse(529, 'overloaded')))

    const pending = handler(makeRequest())
    await vi.advanceTimersByTimeAsync(500)
    const resp = await pending

    expect(global.fetch).toHaveBeenCalledTimes(2) // one retry, then gives up
    expect(resp.status).toBe(529)
    expect(mockReportServerError).toHaveBeenCalledWith(
      'chat',
      expect.objectContaining({ message: expect.stringContaining('Anthropic 529') }),
      { status: 529 }
    )
    vi.useRealTimers()
  })

  it('reports and returns 500 when the fetch call itself throws (a real network failure)', async () => {
    global.fetch.mockRejectedValue(new Error('network down'))
    const resp = await handler(makeRequest())
    expect(resp.status).toBe(500)
    expect(mockReportServerError).toHaveBeenCalledWith('chat', expect.objectContaining({ message: 'network down' }))
  })
})
