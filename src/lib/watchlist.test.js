import { describe, it, expect, vi, beforeEach } from 'vitest'

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }))
vi.mock('./supabase', () => ({ supabase: { from: fromMock } }))

import { getWatchlistCompanyNames, buildWatchlistChatHint } from './watchlist.js'

function makeBuilder(result) {
  const builder = {}
  const chain = () => builder
  Object.assign(builder, {
    select: vi.fn(chain),
    order: vi.fn(chain),
    limit: vi.fn(chain),
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

describe('getWatchlistCompanyNames', () => {
  it('is team-scoped by RLS — reads both companies and candidates with no client-side user_id/team_id filter', async () => {
    mockTables({
      companies: { data: [{ name: 'Acme Corp' }], error: null },
      candidates: { data: [{ company: 'Beta Industries' }], error: null },
    })
    const result = await getWatchlistCompanyNames()
    expect(fromMock).toHaveBeenCalledWith('companies')
    expect(fromMock).toHaveBeenCalledWith('candidates')
    expect(result.sort()).toEqual(['Acme Corp', 'Beta Industries'])
  })

  it('dedupes a company name showing up from both a companies row and a candidate\'s employer', async () => {
    mockTables({
      companies: { data: [{ name: 'Acme Corp' }], error: null },
      candidates: { data: [{ company: 'Acme Corp' }], error: null },
    })
    expect(await getWatchlistCompanyNames()).toEqual(['Acme Corp'])
  })

  it('respects the requested cap', async () => {
    mockTables({
      companies: { data: [{ name: 'A' }, { name: 'B' }, { name: 'C' }], error: null },
    })
    const result = await getWatchlistCompanyNames(2)
    expect(result).toHaveLength(2)
  })

  it('logs rather than throws on a query error, returning whatever the other query found', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockTables({
      companies: { data: [{ name: 'Acme Corp' }], error: null },
      candidates: { data: null, error: { message: 'db down' } },
    })
    const result = await getWatchlistCompanyNames()
    expect(result).toEqual(['Acme Corp'])
    expect(consoleSpy).toHaveBeenCalledWith('[watchlist] failed to read candidates:', 'db down')
    consoleSpy.mockRestore()
  })

  it('never throws even if the underlying call blows up unexpectedly', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    fromMock.mockImplementation(() => { throw new Error('kaboom') })
    const result = await getWatchlistCompanyNames()
    expect(result).toEqual([])
    expect(consoleSpy).toHaveBeenCalledWith('[watchlist] failed to read watchlist companies:', 'kaboom')
    consoleSpy.mockRestore()
  })
})

describe('buildWatchlistChatHint', () => {
  it('returns an empty string with nothing to mention', () => {
    expect(buildWatchlistChatHint([])).toBe('')
    expect(buildWatchlistChatHint(null)).toBe('')
    expect(buildWatchlistChatHint(undefined)).toBe('')
  })

  it('names every tracked company and invites Annie to reference known competitors', () => {
    const hint = buildWatchlistChatHint(['Acme Corp', 'Beta Industries'])
    expect(hint).toContain('Acme Corp')
    expect(hint).toContain('Beta Industries')
    expect(hint).toContain('competitors')
  })
})
