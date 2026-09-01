// intelligence-scan-background.js is the actual twice-daily research loop
// across every customer — its own AI-prompt/dedup/enrichment logic is
// scanShared.js's, already covered by scanShared.test.js. What's specific to
// this file and worth its own coverage: the internal-secret auth guard (this
// file is directly URL-reachable, unlike the old combined schedule+
// background function it replaced — see the file's own header), the method
// guard, the "not configured" short-circuit, and the empty-customer-list
// short-circuit — the ways this run can end before ever spending an
// Anthropic/Apollo credit.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockCreateClient } = vi.hoisted(() => ({ mockCreateClient: vi.fn() }))
vi.mock('@supabase/supabase-js', () => ({ createClient: mockCreateClient }))

function makeRequest({ method = 'POST', secret = 'test-internal-secret' } = {}) {
  const headers = {}
  if (secret !== null) headers['x-internal-scan-secret'] = secret
  return new Request('https://annie.example/.netlify/functions/intelligence-scan-background', { method, headers })
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
let interleaveSignalLists

beforeEach(async () => {
  vi.clearAllMocks()
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service_role_x'
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
  process.env.INTERNAL_SCAN_SECRET = 'test-internal-secret'
  vi.resetModules()
  ;({ default: handler, interleaveSignalLists } = await import('../intelligence-scan-background.js'))
})

afterEach(() => {
  delete process.env.INTERNAL_SCAN_SECRET
})

describe('internal-secret auth guard', () => {
  it('rejects a request with no secret header at all', async () => {
    const res = await handler(makeRequest({ secret: null }))
    expect(res.status).toBe(401)
    expect(mockCreateClient).not.toHaveBeenCalled()
  })

  it('rejects a request with the wrong secret', async () => {
    const res = await handler(makeRequest({ secret: 'not-the-real-secret' }))
    expect(res.status).toBe(401)
    expect(mockCreateClient).not.toHaveBeenCalled()
  })

  it('rejects every request, even with a correct-looking header, when INTERNAL_SCAN_SECRET itself is not configured', async () => {
    delete process.env.INTERNAL_SCAN_SECRET
    vi.resetModules()
    ;({ default: handler } = await import('../intelligence-scan-background.js'))
    const res = await handler(makeRequest({ secret: 'test-internal-secret' }))
    expect(res.status).toBe(401)
    expect(mockCreateClient).not.toHaveBeenCalled()
  })

  it('accepts a request with the correct secret', async () => {
    mockCreateClient.mockReturnValue(makeSupabase({ data: [], error: null }))
    const res = await handler(makeRequest())
    expect(res.status).toBe(200)
  })
})

describe('method and configuration guards', () => {
  it('rejects non-POST methods', async () => {
    const res = await handler(makeRequest({ method: 'GET' }))
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

// 2026-09-01: this file now runs a second AI call per customer (sector-scoped
// + cross-industry-by-function), so a plain concat-then-slice ahead of
// MAX_SIGNALS_PER_RUN (5) would let whichever list happens to be longer, or
// gets checked first, silently take every slot every run — starving the
// other call's results completely even though both are real, deduped
// signals. interleaveSignalLists is the fix; these tests cover it directly
// since the handler-level tests above deliberately don't mock Anthropic/
// Apollo/Adzuna far enough to exercise scanOneCustomer's internals.
describe('interleaveSignalLists (2026-09-01: cross-industry-by-function second call)', () => {
  const sig = (company, headline, sourceUrl = `https://example.com/${company}`) => ({ company, headline, sourceUrl })

  it('alternates round-robin between the two lists instead of exhausting one first', () => {
    const sectorList = [sig('Acme', 'Acme raises Series B'), sig('Globex', 'Globex expands to Dubai')]
    const crossIndustryList = [sig('Initech', 'Initech names new CFO'), sig('Umbrella', 'Umbrella hires Head of Product')]
    const out = interleaveSignalLists([sectorList, crossIndustryList])
    expect(out.map(s => s.company)).toEqual(['Acme', 'Initech', 'Globex', 'Umbrella'])
  })

  it('when one list is longer, still includes the shorter list\'s entries near the front rather than only after the longer list is exhausted', () => {
    const sectorList = [sig('A', 'A funding'), sig('B', 'B funding'), sig('C', 'C funding'), sig('D', 'D funding')]
    const crossIndustryList = [sig('E', 'E leadership change')]
    const out = interleaveSignalLists([sectorList, crossIndustryList])
    // E must land in the first 2 slots, not be pushed to the back by A-D
    expect(out.slice(0, 2).map(s => s.company)).toContain('E')
  })

  it('dedupes the same real-world fact appearing in both lists, keeping only the first occurrence', () => {
    const sectorList = [sig('Acme', 'Acme raises Series B', 'https://techcrunch.com/acme-b')]
    const crossIndustryList = [sig('Acme', 'Acme raises Series B', 'https://techcrunch.com/acme-b'), sig('Initech', 'Initech names new CFO')]
    const out = interleaveSignalLists([sectorList, crossIndustryList])
    expect(out.filter(s => s.company === 'Acme')).toHaveLength(1)
    expect(out.map(s => s.company)).toEqual(['Acme', 'Initech'])
  })

  it('drops entries missing a company or headline rather than throwing', () => {
    const sectorList = [sig('Acme', 'Acme raises Series B'), { company: 'NoHeadline' }]
    const crossIndustryList = [{ headline: 'No company here' }, sig('Initech', 'Initech names new CFO')]
    const out = interleaveSignalLists([sectorList, crossIndustryList])
    expect(out.map(s => s.company)).toEqual(['Acme', 'Initech'])
  })

  it('handles the cross-industry call returning nothing (e.g. customer picked no functions) by passing the sector list through unchanged', () => {
    const sectorList = [sig('Acme', 'Acme raises Series B'), sig('Globex', 'Globex expands to Dubai')]
    const out = interleaveSignalLists([sectorList, []])
    expect(out.map(s => s.company)).toEqual(['Acme', 'Globex'])
  })

  it('handles both lists being empty', () => {
    expect(interleaveSignalLists([[], []])).toEqual([])
  })

  it('handles a null/undefined entry in the lists array (defensive against a failed call resolving to null)', () => {
    const sectorList = [sig('Acme', 'Acme raises Series B')]
    const out = interleaveSignalLists([sectorList, null])
    expect(out.map(s => s.company)).toEqual(['Acme'])
  })
})
