// A production-readiness audit (2026-08-22) flagged chat.js as untested
// despite being the one function that spends real, unmetered-until-recently
// Anthropic API cost on every call. These tests cover exactly the gates that
// audit called for: a genuine, logged-in caller is required (never a
// client-supplied identity), the per-minute rate limit and the daily token
// cap are both enforced before the Anthropic call ever fires, a malformed
// body or an Anthropic-side failure surfaces as the right status instead of
// crashing the handler, and the server-enforced ceilings (maxTokens,
// maxSearchUses, the model allowlist) actually clamp a client that asks for
// more than they're allowed.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetAuthedUser } = vi.hoisted(() => ({ mockGetAuthedUser: vi.fn() }))
const { mockReserveAnthropicTokens, mockReserveChatCall } = vi.hoisted(() => ({
  mockReserveAnthropicTokens: vi.fn(),
  mockReserveChatCall: vi.fn(),
}))
const { mockReportServerError } = vi.hoisted(() => ({ mockReportServerError: vi.fn() }))
const { mockCreateClient } = vi.hoisted(() => ({ mockCreateClient: vi.fn() }))

vi.mock('../lib/auth.js', () => ({ getAuthedUser: mockGetAuthedUser }))
vi.mock('../lib/aiUsage.js', () => ({
  reserveAnthropicTokens: mockReserveAnthropicTokens,
  reserveChatCall: mockReserveChatCall,
}))
vi.mock('../lib/reportError.js', () => ({ reportServerError: mockReportServerError }))
vi.mock('@supabase/supabase-js', () => ({ createClient: mockCreateClient }))

function makeRequest(body, { method = 'POST' } = {}) {
  return new Request('https://annie.example/api/chat', {
    method,
    body: method === 'GET' ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  })
}

let handler

beforeEach(async () => {
  vi.clearAllMocks()
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co'
  process.env.VITE_SUPABASE_ANON_KEY = 'anon_x'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service_role_x'
  delete process.env.CHAT_PER_MINUTE_CAP
  delete process.env.ANTHROPIC_DAILY_TOKEN_CAP

  mockGetAuthedUser.mockResolvedValue({ user: { id: 'user_123' }, error: null })
  mockReserveChatCall.mockResolvedValue(true)
  mockReserveAnthropicTokens.mockResolvedValue(true)
  mockCreateClient.mockReturnValue({})
  global.fetch = vi.fn()

  // Re-imported per test, same reasoning as stripe-webhook.test.js — every
  // env read happens inside the handler, nothing module-level to worry
  // about, but resetModules keeps mock state from bleeding across tests.
  vi.resetModules()
  ;({ default: handler } = await import('../chat.js'))
})

describe('method and configuration guards', () => {
  it('rejects non-POST requests', async () => {
    const res = await handler(makeRequest(null, { method: 'GET' }))
    expect(res.status).toBe(405)
  })

  it('returns 500 when required env vars are missing', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const res = await handler(makeRequest({ messages: [] }))
    expect(res.status).toBe(500)
    expect(mockGetAuthedUser).not.toHaveBeenCalled()
  })
})

describe('authentication', () => {
  it('returns 401 and never checks rate limits for an unauthenticated caller', async () => {
    mockGetAuthedUser.mockResolvedValue({ user: null, error: 'invalid_session' })
    const res = await handler(makeRequest({ messages: [] }))
    expect(res.status).toBe(401)
    expect(mockReserveChatCall).not.toHaveBeenCalled()
  })
})

describe('rate limiting and cost caps', () => {
  it('returns 429 and never calls Anthropic when the per-minute rate limit is hit', async () => {
    mockReserveChatCall.mockResolvedValue(false)
    const res = await handler(makeRequest({ messages: [{ role: 'user', content: 'hi' }] }))
    expect(res.status).toBe(429)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('checks the rate limit before parsing the request body, so a malformed body from a rate-limited caller still reports 429', async () => {
    mockReserveChatCall.mockResolvedValue(false)
    const res = await handler(makeRequest('not json'))
    expect(res.status).toBe(429)
  })

  it('returns 429 when the daily Anthropic token cap is reached, after the body has been validated', async () => {
    mockReserveAnthropicTokens.mockResolvedValue(false)
    const res = await handler(makeRequest({ messages: [{ role: 'user', content: 'hi' }] }))
    expect(res.status).toBe(429)
    const json = await res.json()
    expect(json.error).toMatch(/research budget/i)
    expect(global.fetch).not.toHaveBeenCalled()
  })
})

describe('request body handling', () => {
  it('returns 400 for a malformed request body', async () => {
    const res = await handler(makeRequest('not json'))
    expect(res.status).toBe(400)
  })

  it('clamps maxTokens/maxSearchUses to their server-enforced ceilings and only allows the sonnet opt-in, defaulting to haiku otherwise', async () => {
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ content: [] }) })
    await handler(makeRequest({ messages: [], maxTokens: 999999, maxSearchUses: 999, model: 'some-other-model', webSearch: true }))
    const [, opts] = global.fetch.mock.calls[0]
    const payload = JSON.parse(opts.body)
    expect(payload.max_tokens).toBe(4000)
    expect(payload.model).toBe('claude-haiku-4-5-20251001')
    expect(payload.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }])
  })

  it('honors the sonnet model opt-in when explicitly requested', async () => {
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ content: [] }) })
    await handler(makeRequest({ messages: [], model: 'claude-sonnet-4-5-20250929' }))
    const [, opts] = global.fetch.mock.calls[0]
    expect(JSON.parse(opts.body).model).toBe('claude-sonnet-4-5-20250929')
  })

  it('omits the web_search tool entirely when webSearch is not requested', async () => {
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ content: [] }) })
    await handler(makeRequest({ messages: [] }))
    const [, opts] = global.fetch.mock.calls[0]
    expect(JSON.parse(opts.body).tools).toBeUndefined()
  })
})

describe('Anthropic response handling', () => {
  it('passes through the Anthropic error status and body when the upstream call fails', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 529, text: async () => 'overloaded' })
    const res = await handler(makeRequest({ messages: [{ role: 'user', content: 'hi' }] }))
    expect(res.status).toBe(529)
    const json = await res.json()
    expect(json.error).toBe('overloaded')
  })

  it('joins every text block and collects citations, skipping non-text blocks like tool_use', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [
          { type: 'text', text: 'Hello', citations: [{ url: 'https://a.example', title: 'A' }] },
          { type: 'tool_use', id: 'toolu_1' },
          { type: 'text', text: 'World' },
        ],
      }),
    })
    const res = await handler(makeRequest({ messages: [{ role: 'user', content: 'hi' }] }))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.text).toBe('Hello\nWorld')
    expect(json.citations).toEqual([{ url: 'https://a.example', title: 'A' }])
  })

  it('reports and returns 500 when the Anthropic call itself throws (e.g. a network error)', async () => {
    global.fetch.mockRejectedValue(new Error('network down'))
    const res = await handler(makeRequest({ messages: [{ role: 'user', content: 'hi' }] }))
    expect(res.status).toBe(500)
    expect(mockReportServerError).toHaveBeenCalledWith('chat', expect.any(Error))
    const json = await res.json()
    expect(json.error).toBe('network down')
  })
})
