// parse-cvs-bulk-background.js — "dump multiple CVs and Annie can add it
// for you" (mid-turn addition to item 3). Covers auth, path-ownership
// filtering, the full create-a-candidate-per-CV happy path, and every
// per-file failure mode (download, extraction, empty parse, rate cap,
// Anthropic failure) continuing on to the next file rather than aborting
// the whole batch.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetAuthedUser } = vi.hoisted(() => ({ mockGetAuthedUser: vi.fn() }))
const { mockReserveAnthropicTokens } = vi.hoisted(() => ({ mockReserveAnthropicTokens: vi.fn().mockResolvedValue(true) }))
const { mockGetEntitlements, mockResolveResourceCaps } = vi.hoisted(() => ({
  mockGetEntitlements: vi.fn().mockResolvedValue({ tier: 'starter' }),
  mockResolveResourceCaps: vi.fn().mockReturnValue({ anthropicTokens: { userDailyCap: 1000, platformDailyCap: 10000 } }),
}))
const { mockReportServerError } = vi.hoisted(() => ({ mockReportServerError: vi.fn().mockResolvedValue(undefined) }))
const { mockExtractCvText, mockLooksLikeUsableCvText, mockExtractJsonObject, mockSanitizeParsedCv, mockParsedCvIsEmpty } = vi.hoisted(() => ({
  mockExtractCvText: vi.fn(),
  mockLooksLikeUsableCvText: vi.fn().mockReturnValue(true),
  mockExtractJsonObject: vi.fn(),
  mockSanitizeParsedCv: vi.fn(raw => ({
    name: raw?.name || '', email: raw?.email || '', phone: '', location: '', current_company: raw?.current_company || '', current_role: raw?.current_role || '',
    nationality: '', titles: raw?.titles || [], industries: raw?.industries || [], years_experience: null,
  })),
  mockParsedCvIsEmpty: vi.fn(parsed => !parsed.name && !parsed.current_role),
}))
const { mockSetJSON, mockGetStore } = vi.hoisted(() => {
  const mockSetJSON = vi.fn().mockResolvedValue(undefined)
  return { mockSetJSON, mockGetStore: vi.fn(() => ({ setJSON: mockSetJSON })) }
})

vi.mock('../lib/auth.js', () => ({ getAuthedUser: mockGetAuthedUser }))
vi.mock('../lib/aiUsage.js', () => ({ reserveAnthropicTokens: mockReserveAnthropicTokens }))
vi.mock('../lib/entitlements.js', () => ({ getEntitlements: mockGetEntitlements, resolveResourceCaps: mockResolveResourceCaps }))
vi.mock('../lib/reportError.js', () => ({ reportServerError: mockReportServerError }))
vi.mock('@netlify/blobs', () => ({ getStore: mockGetStore }))
vi.mock('../lib/cvParse.js', () => ({
  extractCvText: mockExtractCvText,
  looksLikeUsableCvText: mockLooksLikeUsableCvText,
  buildCvExtractionSystemPrompt: () => 'system prompt',
  extractJsonObject: mockExtractJsonObject,
  sanitizeParsedCv: mockSanitizeParsedCv,
  parsedCvIsEmpty: mockParsedCvIsEmpty,
}))

// A fresh Response object per call — a mocked Response's body can only be
// consumed (.json()) once, so reusing one instance across multiple files in
// the same batch would make every file after the first silently fail its
// own .json() read (the exact gotcha chat.test.js's own header warns about
// for its retry-response mocking).
function anthropicOkResponse(obj) {
  return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(obj) }] }), { status: 200 })
}

const fakeFile = { arrayBuffer: () => Promise.resolve(new TextEncoder().encode('fake bytes').buffer) }

function makeSupabaseClient({ downloadResult = { data: fakeFile, error: null }, insertResult = { data: { id: 'cand_1', name: 'Jane Doe' }, error: null } } = {}) {
  const insert = vi.fn(() => ({ select: () => ({ single: () => Promise.resolve(insertResult) }) }))
  return {
    storage: { from: vi.fn(() => ({ download: vi.fn().mockResolvedValue(downloadResult) })) },
    from: vi.fn((table) => {
      if (table === 'candidates') return { insert }
      return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }
    }),
    __insert: insert,
  }
}

const { mockCreateClient } = vi.hoisted(() => ({ mockCreateClient: vi.fn() }))
vi.mock('@supabase/supabase-js', () => ({ createClient: mockCreateClient }))

function makeRequest(body) {
  return new Request('https://annie.example/.netlify/functions/parse-cvs-bulk-background', { method: 'POST', body: JSON.stringify(body) })
}

let handler
let supabaseClient

beforeEach(async () => {
  vi.clearAllMocks()
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co'
  process.env.VITE_SUPABASE_ANON_KEY = 'anon_x'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service_role_x'

  mockGetAuthedUser.mockResolvedValue({ user: { id: 'user_123' }, error: null })
  mockReserveAnthropicTokens.mockResolvedValue(true)
  mockLooksLikeUsableCvText.mockReturnValue(true)
  mockExtractCvText.mockResolvedValue('a realistic amount of extracted CV text goes here for the check to pass')
  mockExtractJsonObject.mockReturnValue({ name: 'Jane Doe', current_role: 'Senior PM' })
  mockParsedCvIsEmpty.mockReturnValue(false)

  supabaseClient = makeSupabaseClient()
  mockCreateClient.mockReturnValue(supabaseClient)

  global.fetch = vi.fn().mockImplementation(() => Promise.resolve(anthropicOkResponse({ name: 'Jane Doe', current_role: 'Senior PM' })))

  vi.resetModules()
  ;({ default: handler } = await import('../parse-cvs-bulk-background.js'))
})

describe('method and auth guards', () => {
  it('does nothing for a non-POST request', async () => {
    await handler(new Request('https://annie.example/x', { method: 'GET' }))
    expect(mockGetAuthedUser).not.toHaveBeenCalled()
  })

  it('does nothing when not authenticated', async () => {
    mockGetAuthedUser.mockResolvedValue({ user: null, error: 'invalid_session' })
    await handler(makeRequest({ paths: ['user_123/a.pdf'] }))
    expect(mockSetJSON).not.toHaveBeenCalled()
  })
})

describe('path filtering', () => {
  it('silently drops any path not under the caller\'s own user_id folder', async () => {
    await handler(makeRequest({ paths: ['user_123/a.pdf', 'someone_else/b.pdf'] }))
    // only one real download attempt (the owned path)
    expect(supabaseClient.storage.from).toHaveBeenCalledTimes(1)
  })

  it('writes a done/empty status when there are no valid paths at all', async () => {
    await handler(makeRequest({ paths: [] }))
    const finalCall = mockSetJSON.mock.calls.at(-1)
    expect(finalCall[1]).toEqual(expect.objectContaining({ status: 'done', total: 0, completed: 0, results: [] }))
  })
})

describe('the successful path', () => {
  it('creates a candidate row per CV and writes a final done status with results', async () => {
    await handler(makeRequest({ paths: ['user_123/a.pdf', 'user_123/b.pdf'] }))
    expect(supabaseClient.__insert).toHaveBeenCalledTimes(2)
    const finalCall = mockSetJSON.mock.calls.at(-1)
    expect(finalCall[0]).toBe('user_123')
    expect(finalCall[1].status).toBe('done')
    expect(finalCall[1].total).toBe(2)
    expect(finalCall[1].completed).toBe(2)
    expect(finalCall[1].results).toHaveLength(2)
    expect(finalCall[1].results[0]).toEqual({ path: 'user_123/a.pdf', outcome: 'created', candidateId: 'cand_1', name: 'Jane Doe' })
  })

  it('writes running status incrementally as each file completes', async () => {
    await handler(makeRequest({ paths: ['user_123/a.pdf', 'user_123/b.pdf'] }))
    const runningCalls = mockSetJSON.mock.calls.filter(c => c[1].status === 'running')
    expect(runningCalls.length).toBeGreaterThanOrEqual(2) // initial + at least one per-file update
  })

  it('stamps the created candidate row with the parsed titles/industries arrays', async () => {
    mockSanitizeParsedCv.mockReturnValue({
      name: 'Jane Doe', email: 'jane@x.com', phone: '', location: 'Dubai', current_company: 'Acme', current_role: 'Senior PM',
      nationality: '', titles: ['VP Marketing'], industries: ['Technology'], years_experience: null,
    })
    await handler(makeRequest({ paths: ['user_123/a.pdf'] }))
    const insertedRow = supabaseClient.__insert.mock.calls[0][0]
    expect(insertedRow.titles).toEqual(['VP Marketing'])
    expect(insertedRow.industries).toEqual(['Technology'])
    expect(insertedRow.source).toBe('Bulk CV import')
  })
})

describe('per-file failures continue the batch rather than aborting it', () => {
  it('reports a failed outcome for a file that fails to download, and still processes the rest', async () => {
    supabaseClient.storage.from = vi.fn()
      .mockReturnValueOnce({ download: vi.fn().mockResolvedValue({ data: null, error: { message: 'not found' } }) })
      .mockReturnValueOnce({ download: vi.fn().mockResolvedValue({ data: fakeFile, error: null }) })

    await handler(makeRequest({ paths: ['user_123/broken.pdf', 'user_123/ok.pdf'] }))
    const finalCall = mockSetJSON.mock.calls.at(-1)[1]
    expect(finalCall.results[0].outcome).toBe('failed')
    expect(finalCall.results[1].outcome).toBe('created')
  })

  it('reports a failed outcome when extraction throws (e.g. a legacy .doc)', async () => {
    mockExtractCvText.mockRejectedValueOnce(new Error('Legacy .doc files can’t be auto-read yet'))
    await handler(makeRequest({ paths: ['user_123/a.doc'] }))
    const finalCall = mockSetJSON.mock.calls.at(-1)[1]
    expect(finalCall.results[0]).toEqual({ path: 'user_123/a.doc', outcome: 'failed', reason: 'Legacy .doc files can’t be auto-read yet' })
    expect(supabaseClient.__insert).not.toHaveBeenCalled()
  })

  it('reports a failed outcome when the extracted text is unusable, without spending an AI call', async () => {
    mockLooksLikeUsableCvText.mockReturnValue(false)
    await handler(makeRequest({ paths: ['user_123/scanned.pdf'] }))
    expect(global.fetch).not.toHaveBeenCalled()
    const finalCall = mockSetJSON.mock.calls.at(-1)[1]
    expect(finalCall.results[0].outcome).toBe('failed')
  })

  it('reports a failed outcome when the parse comes back with no name', async () => {
    mockParsedCvIsEmpty.mockReturnValue(true)
    await handler(makeRequest({ paths: ['user_123/empty.pdf'] }))
    const finalCall = mockSetJSON.mock.calls.at(-1)[1]
    expect(finalCall.results[0].outcome).toBe('failed')
    expect(supabaseClient.__insert).not.toHaveBeenCalled()
  })

  it('reports a failed outcome when the rate cap is hit for that file', async () => {
    mockReserveAnthropicTokens.mockResolvedValue(false)
    await handler(makeRequest({ paths: ['user_123/a.pdf'] }))
    expect(global.fetch).not.toHaveBeenCalled()
    const finalCall = mockSetJSON.mock.calls.at(-1)[1]
    expect(finalCall.results[0].outcome).toBe('failed')
  })

  it('reports a failed outcome and logs the error when the Anthropic call itself fails', async () => {
    global.fetch.mockResolvedValue(new Response('server error', { status: 500 }))
    await handler(makeRequest({ paths: ['user_123/a.pdf'] }))
    const finalCall = mockSetJSON.mock.calls.at(-1)[1]
    expect(finalCall.results[0].outcome).toBe('failed')
    expect(mockReportServerError).toHaveBeenCalledWith('parse-cvs-bulk-background', expect.any(Error), expect.objectContaining({ userId: 'user_123', path: 'user_123/a.pdf' }))
  })

  it('reports a failed outcome when the DB insert itself fails', async () => {
    supabaseClient.__insert.mockReturnValue({ select: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'db down' } }) }) })
    await handler(makeRequest({ paths: ['user_123/a.pdf'] }))
    const finalCall = mockSetJSON.mock.calls.at(-1)[1]
    expect(finalCall.results[0].outcome).toBe('failed')
  })
})
