// recommend-candidates.js — AI-powered "recommend CRM candidates from job
// brief" (replaces the old keyword-overlap "Suggested candidates" panel).
// Deliberately uses the REAL candidateRecommend.js and candidateMatch.js
// (no mocks for either) so the geographic gate and response-parsing safety
// net are exercised for real, not asserted against a stub that could drift
// from the actual implementation — same "test the real thing" precedent as
// cvParse.test.js. Only auth/usage-cap/Supabase-client/error-reporting are
// mocked, same shape as parse-cv.test.js.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetAuthedClient } = vi.hoisted(() => ({ mockGetAuthedClient: vi.fn() }))
const { mockReserveAnthropicTokens } = vi.hoisted(() => ({ mockReserveAnthropicTokens: vi.fn().mockResolvedValue(true) }))
const { mockGetEntitlements, mockResolveResourceCaps } = vi.hoisted(() => ({
  mockGetEntitlements: vi.fn().mockResolvedValue({ tier: 'starter' }),
  mockResolveResourceCaps: vi.fn().mockReturnValue({ anthropicTokens: { userDailyCap: 1000, platformDailyCap: 10000 } }),
}))
const { mockReportServerError } = vi.hoisted(() => ({ mockReportServerError: vi.fn().mockResolvedValue(undefined) }))
const { mockCreateClient } = vi.hoisted(() => ({ mockCreateClient: vi.fn(() => ({})) }))

vi.mock('../lib/auth.js', () => ({ getAuthedClient: mockGetAuthedClient }))
vi.mock('../lib/aiUsage.js', () => ({ reserveAnthropicTokens: mockReserveAnthropicTokens }))
vi.mock('../lib/entitlements.js', () => ({ getEntitlements: mockGetEntitlements, resolveResourceCaps: mockResolveResourceCaps }))
vi.mock('../lib/reportError.js', () => ({ reportServerError: mockReportServerError }))
vi.mock('@supabase/supabase-js', () => ({ createClient: mockCreateClient }))

function anthropicOkResponse(text) {
  return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status: 200 })
}

function makeAuthedClient({ job, jobError = null, candidates = [], candidatesError = null }) {
  return {
    from(table) {
      if (table === 'jobs') {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: job, error: jobError }) }) }) }
      }
      if (table === 'candidates') {
        return { select: () => ({ order: () => Promise.resolve({ data: candidates, error: candidatesError }) }) }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

function makeRequest(body, { method = 'POST', invalidJson = false } = {}) {
  const init = { method }
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = invalidJson ? '{not json' : JSON.stringify(body ?? { job_id: 'job_1' })
  }
  return new Request('https://annie.example/.netlify/functions/recommend-candidates', init)
}

const dubaiJob = { id: 'job_1', title: 'Head of Commercial', industry: 'Retail', notes: 'Needs strong client-facing commercial experience in the GCC.', fee_value: 45000, companies: { name: 'Meraas', industry: 'Retail', location: 'Dubai, UAE' } }

const candidatePool = [
  { id: 'cand_1', name: 'Amira Haddad', role: 'Commercial Director', company: 'DP World', industry: 'Logistics', titles: ['Commercial Director'], industries: ['Logistics'], nationality: '', status: 'sourced', notes: 'Great client relationships.', want_sal: 55000, want_sal_currency: 'AED', notice_period: '1 month', updated_at: '2026-09-01' },
  { id: 'cand_2', name: 'Youssef Ahmed', role: 'Sales Director', company: 'Talabat', industry: 'Tech', titles: [], industries: [], nationality: 'Saudi', status: 'sourced', notes: '', want_sal: 40000, want_sal_currency: 'AED', notice_period: '', updated_at: '2026-09-01' },
]

let handler

beforeEach(async () => {
  vi.clearAllMocks()
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co'
  process.env.VITE_SUPABASE_ANON_KEY = 'anon_x'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service_role_x'

  mockGetAuthedClient.mockResolvedValue({
    client: makeAuthedClient({ job: dubaiJob, candidates: candidatePool }),
    user: { id: 'user_123' },
    error: null,
  })
  mockReserveAnthropicTokens.mockResolvedValue(true)
  global.fetch = vi.fn().mockResolvedValue(anthropicOkResponse(JSON.stringify([{ id: 'cand_1', reason: 'Strong commercial background in the same region.' }])))

  vi.resetModules()
  ;({ default: handler } = await import('../recommend-candidates.js'))
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

  it('returns 400 when job_id is missing', async () => {
    const resp = await handler(makeRequest({}))
    expect(resp.status).toBe(400)
  })

  it('returns ok:false reason not_found when the job does not exist / is not this user’s (RLS)', async () => {
    mockGetAuthedClient.mockResolvedValue({ client: makeAuthedClient({ job: null }), user: { id: 'user_123' }, error: null })
    const resp = await handler(makeRequest())
    const data = await resp.json()
    expect(data.ok).toBe(false)
    expect(data.reason).toBe('not_found')
  })

  it('returns ok:false reason load_failed when the candidate query errors', async () => {
    mockGetAuthedClient.mockResolvedValue({ client: makeAuthedClient({ job: dubaiJob, candidatesError: { message: 'db down' } }), user: { id: 'user_123' }, error: null })
    const resp = await handler(makeRequest())
    const data = await resp.json()
    expect(data.ok).toBe(false)
    expect(data.reason).toBe('load_failed')
  })
})

describe('geographic gate — deterministic, never left to the AI', () => {
  it('excludes an ineligible candidate before ever calling Anthropic, and returns empty when nobody is left', async () => {
    // Only candidate is a Saudi national and the job is in Dubai — not eligible per candidateMatch.js's own rule.
    mockGetAuthedClient.mockResolvedValue({
      client: makeAuthedClient({ job: dubaiJob, candidates: [candidatePool[1]] }),
      user: { id: 'user_123' },
      error: null,
    })
    const resp = await handler(makeRequest())
    const data = await resp.json()
    expect(data.ok).toBe(true)
    expect(data.recommendations).toEqual([])
    expect(global.fetch).not.toHaveBeenCalled() // no AI spend on an empty-after-filtering pool
    expect(mockReserveAnthropicTokens).not.toHaveBeenCalled()
  })

  it('never returns an ineligible candidate even if the model hallucinates their id', async () => {
    // Both candidates are sent in, but only cand_1 is eligible for a Dubai job — the
    // mocked model "recommends" the ineligible cand_2 anyway; the handler must drop it
    // because it was never in candidatesById (built only from the already-filtered pool).
    global.fetch = vi.fn().mockResolvedValue(anthropicOkResponse(JSON.stringify([
      { id: 'cand_2', reason: 'Should never appear.' },
      { id: 'cand_1', reason: 'Strong commercial background in the same region.' },
    ])))
    const resp = await handler(makeRequest())
    const data = await resp.json()
    expect(data.ok).toBe(true)
    expect(data.recommendations.map(r => r.candidate.id)).toEqual(['cand_1'])
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
  it('returns ok:true with the matched candidate object and a sanitized reason', async () => {
    const resp = await handler(makeRequest())
    expect(resp.status).toBe(200)
    const data = await resp.json()
    expect(data.ok).toBe(true)
    expect(data.recommendations).toHaveLength(1)
    expect(data.recommendations[0].candidate.name).toBe('Amira Haddad')
    expect(data.recommendations[0].reason).toBe('Strong commercial background in the same region.')
  })

  it('sends the job brief and eligible candidate summaries to Anthropic', async () => {
    await handler(makeRequest())
    const sentPayload = JSON.parse(global.fetch.mock.calls[0][1].body)
    expect(sentPayload.model).toBe('claude-haiku-4-5-20251001')
    const userMessage = JSON.parse(sentPayload.messages[0].content)
    expect(userMessage.job.title).toBe('Head of Commercial')
    expect(userMessage.candidates.map(c => c.id)).toEqual(['cand_1']) // cand_2 filtered out before the prompt
  })
})

describe('Anthropic failure', () => {
  it('returns ok:false and reports the error when the Anthropic call fails', async () => {
    global.fetch.mockResolvedValue(new Response('server error', { status: 500 }))
    const resp = await handler(makeRequest())
    const data = await resp.json()
    expect(data.ok).toBe(false)
    expect(data.reason).toBe('ai_failed')
    expect(mockReportServerError).toHaveBeenCalledWith('recommend-candidates', expect.any(Error), expect.objectContaining({ userId: 'user_123', jobId: 'job_1' }))
  })

  it('returns ok:false when the fetch itself throws', async () => {
    global.fetch.mockRejectedValue(new Error('network down'))
    const resp = await handler(makeRequest())
    const data = await resp.json()
    expect(data.ok).toBe(false)
    expect(data.reason).toBe('ai_failed')
  })
})
