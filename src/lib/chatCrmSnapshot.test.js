import { describe, it, expect, vi, beforeEach } from 'vitest'

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }))
vi.mock('./supabase', () => ({ supabase: { from: fromMock } }))

import { loadChatCrmSnapshot, buildCrmSnapshotChatHint } from './chatCrmSnapshot.js'

function makeBuilder(result) {
  const builder = {}
  const chain = () => builder
  Object.assign(builder, {
    select: vi.fn(chain),
    eq: vi.fn(chain),
    neq: vi.fn(chain),
    order: vi.fn(chain),
    limit: vi.fn(chain),
    single: vi.fn(() => Promise.resolve(result)),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  })
  return builder
}

function mockTables(byTable) {
  fromMock.mockImplementation((table) => makeBuilder(byTable[table] ?? { data: [], error: null }))
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('loadChatCrmSnapshot', () => {
  it('summarises candidate pipeline counts correctly', async () => {
    mockTables({
      candidates: { data: [{ status: 'sourced' }, { status: 'interviewing' }, { status: 'offer' }, { status: 'placed' }, { status: 'rejected' }], error: null },
      jobs: { data: [], error: null },
      intelligence_signals: { data: [], error: null },
      onboarding: { data: { locations: ['United Kingdom'] }, error: null },
    })
    const snapshot = await loadChatCrmSnapshot('user_1')
    expect(snapshot.candidateStats).toEqual({ total: 5, active: 3, hot: 2 })
  })

  it('reads jobs with company name and fee, and signals scoped to this user and not yet actioned', async () => {
    mockTables({
      candidates: { data: [], error: null },
      jobs: { data: [{ title: 'CFO', status: 'active', fee_value: 96000, companies: { name: 'Aldermere Partners' } }], error: null },
      intelligence_signals: { data: [{ company_name: 'Aldermere Partners', headline: 'Appoints new CFO', signal_type: 'leadership_change', why_it_matters: 'A new CFO often resets vendor relationships.' }], error: null },
      onboarding: { data: { locations: ['United Kingdom'] }, error: null },
    })
    const snapshot = await loadChatCrmSnapshot('user_1')
    expect(snapshot.jobs).toHaveLength(1)
    expect(snapshot.jobs[0].fee_value).toBe(96000)
    expect(snapshot.signals[0].company_name).toBe('Aldermere Partners')
    expect(fromMock).toHaveBeenCalledWith('intelligence_signals')
  })

  it('resolves a currency prefix from onboarding locations, defaulting sensibly when missing', async () => {
    mockTables({
      candidates: { data: [], error: null },
      jobs: { data: [], error: null },
      intelligence_signals: { data: [], error: null },
      onboarding: { data: null, error: null },
    })
    const snapshot = await loadChatCrmSnapshot('user_1')
    expect(snapshot.currencyPrefix).toBe('£')
  })

  it('logs rather than throws on a query error, still returning a usable snapshot', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockTables({
      candidates: { data: null, error: { message: 'db down' } },
      jobs: { data: [], error: null },
      intelligence_signals: { data: [], error: null },
      onboarding: { data: { locations: ['United Kingdom'] }, error: null },
    })
    const snapshot = await loadChatCrmSnapshot('user_1')
    expect(snapshot.candidateStats).toEqual({ total: 0, active: 0, hot: 0 })
    expect(consoleSpy).toHaveBeenCalledWith('[chatCrmSnapshot] failed to read candidates:', 'db down')
    consoleSpy.mockRestore()
  })

  it('never throws even if the underlying call blows up unexpectedly', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    fromMock.mockImplementation(() => { throw new Error('kaboom') })
    const snapshot = await loadChatCrmSnapshot('user_1')
    expect(snapshot).toBeNull()
    consoleSpy.mockRestore()
  })
})

describe('buildCrmSnapshotChatHint', () => {
  it('returns an empty string with no snapshot', () => {
    expect(buildCrmSnapshotChatHint(null)).toBe('')
  })

  it('includes pipeline counts, every job with its fee, and recent signals', () => {
    const hint = buildCrmSnapshotChatHint({
      candidateStats: { total: 18, active: 16, hot: 2 },
      jobs: [{ title: 'Partner, Financial Services', status: 'active', fee_value: 96000, companies: { name: 'Aldermere Partners' } }],
      signals: [{ company_name: 'Aldermere Partners', headline: 'Appoints new CFO', signal_type: 'leadership_change', why_it_matters: 'A new CFO often resets vendor relationships.' }],
      currencyPrefix: '£',
    })
    expect(hint).toContain('18 candidates')
    expect(hint).toContain('16 active')
    expect(hint).toContain('Partner, Financial Services')
    expect(hint).toContain('Aldermere Partners')
    expect(hint).toContain('£96,000')
    expect(hint).toContain('Appoints new CFO')
  })

  it('says plainly when there are no jobs on file, rather than an empty list', () => {
    const hint = buildCrmSnapshotChatHint({ candidateStats: { total: 0, active: 0, hot: 0 }, jobs: [], signals: [], currencyPrefix: '£' })
    expect(hint).toContain('No jobs/mandates on file yet')
  })
})
