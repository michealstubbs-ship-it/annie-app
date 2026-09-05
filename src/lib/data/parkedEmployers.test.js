import { describe, it, expect, vi, beforeEach } from 'vitest'

const { fromMock, rpcMock } = vi.hoisted(() => ({ fromMock: vi.fn(), rpcMock: vi.fn() }))
vi.mock('../supabase', () => ({ supabase: { from: fromMock, rpc: rpcMock } }))

import { fetchOwnEmployerVerdicts, contributeEmployerVerdicts, fetchParkedEmployers } from './parkedEmployers.js'

let outcomeResult

// signal_outcomes is read with a single chained builder, the same shape the
// other single-table modules in this directory mock.
function makeBuilder(result) {
  const builder = {}
  const chain = () => builder
  Object.assign(builder, {
    select: vi.fn(chain),
    eq: vi.fn(chain),
    gte: vi.fn(chain),
    limit: vi.fn(() => Promise.resolve(result)),
  })
  return builder
}

beforeEach(() => {
  vi.clearAllMocks()
  outcomeResult = { data: [], error: null }
  fromMock.mockImplementation(table => {
    if (table === 'signal_outcomes') return makeBuilder(outcomeResult)
    throw new Error(`unexpected table: ${table}`)
  })
  rpcMock.mockResolvedValue({ data: [], error: null })
})

describe('fetchOwnEmployerVerdicts — the read that had never happened', () => {
  it('reads the customer\'s own outcome rows, scoped to them and to the decay window', async () => {
    // signal_outcomes has been written since 21 Aug 2026 and read by nothing.
    // This is the read. user_id is redundant against RLS and present anyway,
    // because it is what makes the query use signal_outcomes_user_id_idx
    // rather than scanning rows the policy then discards.
    const builder = makeBuilder(outcomeResult)
    fromMock.mockReturnValue(builder)
    await fetchOwnEmployerVerdicts('u1')
    expect(fromMock).toHaveBeenCalledWith('signal_outcomes')
    expect(builder.eq).toHaveBeenCalledWith('user_id', 'u1')
    expect(builder.gte.mock.calls[0][0]).toBe('created_at')
    // Only three columns. Nothing that identifies a person or a signal is
    // even fetched, let alone contributed.
    expect(builder.select).toHaveBeenCalledWith('company_name, stage, created_at')
  })

  it('returns an empty map without querying anything when there is no user', async () => {
    const result = await fetchOwnEmployerVerdicts(null)
    expect(result.size).toBe(0)
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('returns an empty map rather than throwing when the read fails', async () => {
    // A ranking refinement must never be able to take the stream down.
    outcomeResult = { data: null, error: { message: 'permission denied' } }
    const result = await fetchOwnEmployerVerdicts('u1')
    expect(result.size).toBe(0)
  })
})

describe('contributeEmployerVerdicts — what actually leaves the tenant', () => {
  it('sends a desk slug and two lists of company keys, and nothing else', async () => {
    // THE BOUNDARY, asserted on the wire rather than described in a comment.
    // Michael, 2026-09-05: "share the fact about the ORGANISATION, never the
    // record about the PERSON."
    contributeEmployerVerdicts(
      new Map([['aldar properties', 'parked'], ['neom', 'worked'], ['adq', 'parked']]),
      ['finance-accounting'],
    )
    expect(rpcMock).toHaveBeenCalledWith('record_parked_employers', {
      p_desk: 'finance-accounting',
      p_parked: ['aldar properties', 'adq'],
      p_worked: ['neom'],
    })
    const payload = JSON.stringify(rpcMock.mock.calls[0][1])
    expect(payload).not.toContain('user')
    expect(payload).not.toContain('signal')
  })

  it('sends one round trip for the whole history, not one per company', async () => {
    const verdicts = new Map()
    for (let i = 0; i < 200; i += 1) verdicts.set(`company ${i}`, 'parked')
    contributeEmployerVerdicts(verdicts, ['finance-accounting'])
    expect(rpcMock).toHaveBeenCalledTimes(1)
  })

  it('sends nothing at all when the customer has no desk', () => {
    // An unsegmented vote pools a finance recruiter's judgment with a
    // construction recruiter's, which is exactly how this feature would make
    // Annie narrower rather than sharper. The RPC refuses it too; this is the
    // client agreeing rather than relying.
    contributeEmployerVerdicts(new Map([['neom', 'parked']]), [])
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('sends nothing when there is nothing to say', () => {
    contributeEmployerVerdicts(new Map(), ['finance-accounting'])
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('never throws when the pool write fails — the feed must not notice', () => {
    rpcMock.mockReturnValue(Promise.reject(new Error('connection reset')))
    expect(() => contributeEmployerVerdicts(new Map([['neom', 'parked']]), ['x-desk'])).not.toThrow()
  })
})

describe('fetchParkedEmployers — reading the pool back', () => {
  it('asks once for the batch, scoped to the caller\'s desks', async () => {
    rpcMock.mockResolvedValue({
      data: [{ company_key: 'aldar properties', parked_voters: 6, worked_voters: 1 }],
      error: null,
    })
    const result = await fetchParkedEmployers(['aldar properties', 'neom'], ['finance-accounting'])
    expect(rpcMock).toHaveBeenCalledTimes(1)
    expect(rpcMock).toHaveBeenCalledWith('parked_employer_signal', {
      p_company_keys: ['aldar properties', 'neom'],
      p_desks: ['finance-accounting'],
    })
    expect(result.get('aldar properties')).toEqual({ parkedVoters: 6, workedVoters: 1 })
  })

  it('records an explicit null for a company the pool says nothing about', async () => {
    // Without this the caller re-asks about the same silent companies on
    // every render — the pool is silent about almost every company, by
    // design, so that would be most of the round trips this feature makes.
    const result = await fetchParkedEmployers(['neom'], ['finance-accounting'])
    expect(result.has('neom')).toBe(true)
    expect(result.get('neom')).toBeNull()
  })

  it('asks nothing when the customer has no desk', async () => {
    const result = await fetchParkedEmployers(['neom'], [])
    expect(result.size).toBe(0)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('degrades to no weight at all when the pool read fails', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'nope' } })
    const result = await fetchParkedEmployers(['neom'], ['finance-accounting'])
    expect(result.get('neom')).toBeNull()
  })
})
