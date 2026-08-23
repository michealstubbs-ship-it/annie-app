// intelligence-scan.js is the twice-daily cron across every customer — its
// own AI-prompt/dedup/enrichment logic is scanShared.js's, already covered
// by scanShared.test.js. What's specific to this file and worth its own
// coverage is the method guard, the "not configured" short-circuit, and the
// empty-customer-list short-circuit — the three ways this run can end before
// ever spending an Anthropic/Apollo credit.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockCreateClient } = vi.hoisted(() => ({ mockCreateClient: vi.fn() }))
vi.mock('@supabase/supabase-js', () => ({ createClient: mockCreateClient }))

function makeRequest(method = 'POST') {
  return new Request('https://annie.example/.netlify/functions/intelligence-scan', { method })
}

function makeSupabase(onboardingResult) {
  const from = vi.fn(() => {
    const builder = {}
    const chain = () => builder
    Object.assign(builder, {
      select: vi.fn(chain),
      order: vi.fn(chain),
      then: (resolve, reject) => Promise.resolve(onboardingResult).then(resolve, reject),
    })
    return builder
  })
  return { from }
}

let handler

beforeEach(async () => {
  vi.clearAllMocks()
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service_role_x'
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
  vi.resetModules()
  ;({ default: handler } = await import('../intelligence-scan.js'))
})

describe('method and configuration guards', () => {
  it('rejects non-POST methods', async () => {
    const res = await handler(makeRequest('GET'))
    expect(res.status).toBe(405)
  })

  it('returns 200 "Not configured" when a required env var is missing, without querying Supabase', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const res = await handler(makeRequest())
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('Not configured')
    expect(mockCreateClient).not.toHaveBeenCalled()
  })
})

describe('empty customer list', () => {
  it('returns 200 "No customers to scan" and does no further work when onboarding has no rows', async () => {
    mockCreateClient.mockReturnValue(makeSupabase({ data: [], error: null }))
    const res = await handler(makeRequest())
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('No customers to scan')
  })

  it('also short-circuits when the onboarding query returns null data', async () => {
    mockCreateClient.mockReturnValue(makeSupabase({ data: null, error: null }))
    const res = await handler(makeRequest())
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('No customers to scan')
  })
})
