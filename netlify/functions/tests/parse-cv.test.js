// parse-cv.js — CV-first candidate form auto-fill (item 3). Covers every
// guard (config, method, auth, ownership-of-path, download failure,
// unsupported/unreadable extraction, rate cap, Anthropic failure) and the
// successful path, without hitting a real Supabase project or Anthropic.
// Lives in tests/, not directly in netlify/functions/, for the same reason
// chat.test.js does — see that file's own header.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetAuthedClient } = vi.hoisted(() => ({ mockGetAuthedClient: vi.fn() }))
const { mockReserveAnthropicTokens } = vi.hoisted(() => ({ mockReserveAnthropicTokens: vi.fn().mockResolvedValue(true) }))
const { mockGetEntitlements, mockResolveResourceCaps } = vi.hoisted(() => ({
  mockGetEntitlements: vi.fn().mockResolvedValue({ tier: 'solo' }),
  mockResolveResourceCaps: vi.fn().mockReturnValue({ anthropicTokens: { userDailyCap: 1000, platformDailyCap: 10000 } }),
}))
const { mockReportServerError } = vi.hoisted(() => ({ mockReportServerError: vi.fn().mockResolvedValue(undefined) }))
const { mockCreateClient } = vi.hoisted(() => ({ mockCreateClient: vi.fn(() => ({})) }))
const { mockExtractCvText, mockLooksLikeUsableCvText, mockExtractJsonObject, mockSanitizeParsedCv, mockParsedCvIsEmpty } = vi.hoisted(() => ({
  mockExtractCvText: vi.fn().mockResolvedValue('Jane Doe, Senior Product Manager at Acme Corp, Dubai UAE, jane@example.com'.repeat(3)),
  mockLooksLikeUsableCvText: vi.fn().mockReturnValue(true),
  mockExtractJsonObject: vi.fn().mockReturnValue({ name: 'Jane Doe', current_role: 'Senior Product Manager' }),
  mockSanitizeParsedCv: vi.fn(raw => ({
    name: raw?.name || '', email: '', phone: '', location: '', current_company: '', current_role: raw?.current_role || '',
    nationality: '', titles: [], industries: [], years_experience: null,
  })),
  mockParsedCvIsEmpty: vi.fn(parsed => !parsed.name && !parsed.current_role),
}))

vi.mock('../lib/auth.js', () => ({ getAuthedClient: mockGetAuthedClient }))
vi.mock('../lib/aiUsage.js', () => ({ reserveAnthropicTokens: mockReserveAnthropicTokens }))
vi.mock('../lib/entitlements.js', () => ({ getEntitlements: mockGetEntitlements, resolveResourceCaps: mockResolveResourceCaps }))
vi.mock('../lib/reportError.js', () => ({ reportServerError: mockReportServerError }))
vi.mock('@supabase/supabase-js', () => ({ createClient: mockCreateClient }))
vi.mock('../lib/cvParse.js', () => ({
  extractCvText: mockExtractCvText,
  looksLikeUsableCvText: mockLooksLikeUsableCvText,
  buildCvExtractionSystemPrompt: () => 'system prompt',
  extractJsonObject: mockExtractJsonObject,
  sanitizeParsedCv: mockSanitizeParsedCv,
  parsedCvIsEmpty: mockParsedCvIsEmpty,
}))

function anthropicOkResponse(text) {
  return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status: 200 })
}

function makeAuthedClient(downloadResult) {
  return {
    storage: {
      from: () => ({
        download: vi.fn().mockResolvedValue(downloadResult),
      }),
    },
  }
}

function makeRequest(body, { method = 'POST', invalidJson = false } = {}) {
  const init = { method }
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = invalidJson ? '{not json' : JSON.stringify(body ?? { path: 'user_123/abc.pdf' })
  }
  return new Request('https://annie.example/.netlify/functions/parse-cv', init)
}

const fakeFile = { arrayBuffer: () => Promise.resolve(new TextEncoder().encode('fake bytes').buffer) }

let handler

beforeEach(async () => {
  vi.clearAllMocks()
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co'
  process.env.VITE_SUPABASE_ANON_KEY = 'anon_x'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service_role_x'

  mockGetAuthedClient.mockResolvedValue({
    client: makeAuthedClient({ data: fakeFile, error: null }),
    user: { id: 'user_123' },
    error: null,
  })
  mockReserveAnthropicTokens.mockResolvedValue(true)
  mockExtractCvText.mockResolvedValue('Jane Doe, Senior Product Manager at Acme Corp, Dubai UAE, jane@example.com'.repeat(3))
  mockLooksLikeUsableCvText.mockReturnValue(true)
  mockExtractJsonObject.mockReturnValue({ name: 'Jane Doe', current_role: 'Senior Product Manager' })
  mockParsedCvIsEmpty.mockReturnValue(false)

  global.fetch = vi.fn().mockResolvedValue(anthropicOkResponse('{"name":"Jane Doe"}'))

  vi.resetModules()
  ;({ default: handler } = await import('../parse-cv.js'))
})

describe('method and configuration guards', () => {
  it('rejects a non-POST request without touching auth', async () => {
    const resp = await handler(makeRequest(undefined, { method: 'GET' }))
    expect(resp.status).toBe(405)
    expect(mockGetAuthedClient).not.toHaveBeenCalled()
  })

  it('returns 500 when required config is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const resp = await handler(makeRequest())
    expect(resp.status).toBe(500)
    expect(mockGetAuthedClient).not.toHaveBeenCalled()
  })
})

describe('auth and request guards', () => {
  it('returns 401 when not authenticated', async () => {
    mockGetAuthedClient.mockResolvedValue({ client: null, user: null, error: 'invalid_session' })
    const resp = await handler(makeRequest())
    expect(resp.status).toBe(401)
  })

  it('returns 400 on an unparseable body', async () => {
    const resp = await handler(makeRequest(undefined, { invalidJson: true }))
    expect(resp.status).toBe(400)
  })

  it('returns 400 when path is missing', async () => {
    const resp = await handler(makeRequest({}))
    expect(resp.status).toBe(400)
  })

  it('returns 403 when the path does not belong to the authenticated user (defense in depth over storage RLS)', async () => {
    const resp = await handler(makeRequest({ path: 'someone_else/abc.pdf' }))
    expect(resp.status).toBe(403)
  })
})

describe('download and extraction failures', () => {
  it('returns ok:false when the storage download fails', async () => {
    mockGetAuthedClient.mockResolvedValue({ client: makeAuthedClient({ data: null, error: { message: 'not found' } }), user: { id: 'user_123' }, error: null })
    const resp = await handler(makeRequest())
    const data = await resp.json()
    expect(data.ok).toBe(false)
    expect(data.reason).toBe('download_failed')
  })

  it('returns ok:false with reason "unsupported" when extraction throws (e.g. a legacy .doc)', async () => {
    mockExtractCvText.mockRejectedValue(new Error('Legacy .doc files can’t be auto-read yet'))
    const resp = await handler(makeRequest())
    const data = await resp.json()
    expect(data.ok).toBe(false)
    expect(data.reason).toBe('unsupported')
    expect(data.message).toContain('Legacy .doc')
  })

  it('returns ok:false with reason "unreadable" when the extracted text is too short/empty (e.g. a scanned PDF)', async () => {
    mockLooksLikeUsableCvText.mockReturnValue(false)
    const resp = await handler(makeRequest())
    const data = await resp.json()
    expect(data.ok).toBe(false)
    expect(data.reason).toBe('unreadable')
    expect(global.fetch).not.toHaveBeenCalled() // never spends an AI call on unusable text
  })
})

describe('rate/budget guard', () => {
  it('returns 429 and never calls Anthropic when the daily token cap is hit', async () => {
    mockReserveAnthropicTokens.mockResolvedValue(false)
    const resp = await handler(makeRequest())
    expect(resp.status).toBe(429)
    expect(global.fetch).not.toHaveBeenCalled()
  })
})

describe('the successful path', () => {
  it('returns ok:true with the sanitized parsed fields', async () => {
    const resp = await handler(makeRequest())
    expect(resp.status).toBe(200)
    const data = await resp.json()
    expect(data.ok).toBe(true)
    expect(data.parsed.name).toBe('Jane Doe')
    expect(mockReportServerError).not.toHaveBeenCalled()
  })

  it('sends the extracted CV text to Anthropic as the user message', async () => {
    await handler(makeRequest())
    const sentPayload = JSON.parse(global.fetch.mock.calls[0][1].body)
    expect(sentPayload.messages).toEqual([{ role: 'user', content: expect.stringContaining('Jane Doe') }])
    expect(sentPayload.model).toBe('claude-haiku-4-5-20251001')
  })

  it('returns ok:false with reason "empty" when nothing usable came back from the AI', async () => {
    mockParsedCvIsEmpty.mockReturnValue(true)
    const resp = await handler(makeRequest())
    const data = await resp.json()
    expect(data.ok).toBe(false)
    expect(data.reason).toBe('empty')
  })
})

describe('Anthropic failure', () => {
  it('returns ok:false and reports the error when the Anthropic call fails', async () => {
    global.fetch.mockResolvedValue(new Response('server error', { status: 500 }))
    const resp = await handler(makeRequest())
    const data = await resp.json()
    expect(data.ok).toBe(false)
    expect(data.reason).toBe('ai_failed')
    expect(mockReportServerError).toHaveBeenCalledWith('parse-cv', expect.any(Error), expect.objectContaining({ userId: 'user_123' }))
  })

  it('returns ok:false when the fetch itself throws', async () => {
    global.fetch.mockRejectedValue(new Error('network down'))
    const resp = await handler(makeRequest())
    const data = await resp.json()
    expect(data.ok).toBe(false)
    expect(data.reason).toBe('ai_failed')
  })
})
