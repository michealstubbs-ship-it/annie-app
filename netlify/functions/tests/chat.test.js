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
// A generic chainable query-builder stub for the client chat.js constructs
// itself. chat.js's own usage-cap RPCs go through aiUsage.js (mocked
// above), but the 2026-08-24 plan-tier soft gate (entitlements.js + the
// chat_messages count check) calls supabase.from(...).select(...).eq(...)
// directly on this client, so it needs to resolve to something sane rather
// than throwing "not a function". Defaults to "no team membership found" /
// "0 messages this month", which resolves to Starter-level defaults and
// never trips the cap in tests that don't care about it.
const { mockCreateClient } = vi.hoisted(() => {
  function makeChainableResult(result = { data: null, count: 0, error: null }) {
    const builder = {
      select: () => builder,
      eq: () => builder,
      gte: () => builder,
      in: () => builder,
      order: () => builder,
      maybeSingle: () => Promise.resolve(result),
      then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
    }
    return builder
  }
  return { mockCreateClient: vi.fn(() => ({ from: () => makeChainableResult() })) }
})

vi.mock('../lib/auth.js', () => ({ getAuthedUser: mockGetAuthedUser }))
vi.mock('../lib/aiUsage.js', () => ({
  reserveAnthropicTokens: mockReserveAnthropicTokens,
  reserveChatCall: mockReserveChatCall,
}))
vi.mock('../lib/reportError.js', () => ({ reportServerError: mockReportServerError }))
vi.mock('@supabase/supabase-js', () => ({ createClient: mockCreateClient }))

// Defaults to stream:true since most of this file's existing tests target
// the streaming path (callChatStream/Chat.jsx). The 2026-08-26 fix made
// streaming opt-in per request rather than unconditional — see the
// dedicated "non-streaming path" describe block below for callChat()'s
// plain-JSON callers (support widget, candidate-pitch batch, etc.).
function makeRequest(body, { method = 'POST', invalidJson = false } = {}) {
  const init = { method }
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = invalidJson ? '{not json' : JSON.stringify(body ?? { messages: [{ role: 'user', content: 'hi' }], stream: true })
  }
  return new Request('https://annie.example/api/chat', init)
}

// chat.js now requests stream:true and re-emits Anthropic's SSE stream as
// NDJSON — this builds a real SSE body (data: {...}\n\n lines) matching what
// Anthropic actually sends, so the mocked fetch exercises the real
// streaming/parsing code path instead of a shape chat.js no longer produces.
function anthropicOkResponse(text = 'hello there') {
  const events = [
    { type: 'message_start', message: { id: 'msg_1' } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ]
  const body = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, { status: 200 })
}

function anthropicErrorResponse(status, body = 'upstream error') {
  return new Response(body, { status })
}

// The plain (non-streaming) shape Anthropic returns when stream isn't set —
// what chat.js's non-streaming branch (every caller besides Chat.jsx) parses.
function anthropicNonStreamResponse(text = 'hello there') {
  return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status: 200 })
}

// Reads chat.js's NDJSON response body to completion and returns the
// concatenated delta text plus the final done event's citations, mirroring
// what callChatStream() does client-side.
async function readNdjson(resp) {
  const lines = (await resp.text()).trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  const text = lines.filter(e => e.type === 'delta').map(e => e.text).join('')
  const done = lines.find(e => e.type === 'done')
  return { text, citations: done?.citations || [], lines }
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
  it('streams the assistant text as NDJSON deltas followed by a done event, and never reports an error', async () => {
    const resp = await handler(makeRequest())
    expect(resp.status).toBe(200)
    expect(resp.headers.get('Content-Type')).toContain('application/x-ndjson')
    const { text, lines } = await readNdjson(resp)
    expect(text).toBe('hello there')
    expect(lines[lines.length - 1]).toEqual({ type: 'done', citations: [] })
    expect(mockReportServerError).not.toHaveBeenCalled()
  })
})

describe('the non-streaming path — every caller besides Chat.jsx', () => {
  // 2026-08-26 regression target: chat.js used to always request stream:true
  // and always respond with NDJSON, which broke every caller still using
  // plain callChat() (support widget, Today's Actions candidate pitches,
  // the writing-style analyser) — they call resp.json() on what had become
  // an NDJSON body and it silently threw. Streaming is now opt-in via
  // `stream: true` in the request body; omitting it (as callChat() does)
  // must still get back the original { text, citations } JSON shape.
  it('returns plain JSON { text, citations } when stream is not requested', async () => {
    global.fetch = vi.fn().mockResolvedValue(anthropicNonStreamResponse('hello there'))
    const resp = await handler(makeRequest({ messages: [{ role: 'user', content: 'hi' }] }))
    expect(resp.status).toBe(200)
    expect(resp.headers.get('Content-Type')).toContain('application/json')
    const data = await resp.json()
    expect(data).toEqual({ text: 'hello there', citations: [] })
    expect(mockReportServerError).not.toHaveBeenCalled()
  })

  it('sends stream:false through to Anthropic when the caller omits stream', async () => {
    global.fetch = vi.fn().mockResolvedValue(anthropicNonStreamResponse())
    await handler(makeRequest({ messages: [{ role: 'user', content: 'hi' }] }))
    const sentPayload = JSON.parse(global.fetch.mock.calls[0][1].body)
    expect(sentPayload.stream).toBe(false)
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
    const { text } = await readNdjson(resp)
    expect(text).toBe('recovered on retry')
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
