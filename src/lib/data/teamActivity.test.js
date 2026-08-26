import { describe, it, expect, vi, beforeEach } from 'vitest'

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }))
vi.mock('../supabase', () => ({ supabase: { from: fromMock } }))

import { getTeamActivitySummary } from './teamActivity.js'

// Two different tables are queried concurrently (intelligence_signals,
// todays_action_state) — route each to its own builder/result by table name
// rather than sharing one generic builder like the single-table modules do.
function makeBuilder(result) {
  const builder = {}
  const chain = () => builder
  Object.assign(builder, {
    select: vi.fn(chain),
    in: vi.fn(chain),
    gte: vi.fn(chain),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  })
  return builder
}

let signalsResult
let actionStateResult

beforeEach(() => {
  vi.clearAllMocks()
  signalsResult = { data: [], error: null }
  actionStateResult = { data: [], error: null }
  fromMock.mockImplementation(table => {
    if (table === 'intelligence_signals') return makeBuilder(signalsResult)
    if (table === 'todays_action_state') return makeBuilder(actionStateResult)
    throw new Error(`unexpected table: ${table}`)
  })
})

describe('getTeamActivitySummary', () => {
  it('returns an empty map for an empty/missing id list without querying anything', async () => {
    const result = await getTeamActivitySummary([])
    expect(result.size).toBe(0)
    expect(fromMock).not.toHaveBeenCalled()

    const resultUndefined = await getTeamActivitySummary(undefined)
    expect(resultUndefined.size).toBe(0)
  })

  it('seeds a zeroed row for every requested id, even one with no activity at all', async () => {
    const result = await getTeamActivitySummary(['u1', 'u2'])
    expect(result.get('u1')).toEqual({ newSignals: 0, actionedSignals: 0, actionsDone: 0, actionsPending: 0 })
    expect(result.get('u2')).toEqual({ newSignals: 0, actionedSignals: 0, actionsDone: 0, actionsPending: 0 })
  })

  it('dedupes the requested id list', async () => {
    const result = await getTeamActivitySummary(['u1', 'u1', 'u1'])
    expect(result.size).toBe(1)
  })

  it('tallies new vs actioned signals per user from the last 7 days, and done vs pending action-state', async () => {
    signalsResult = {
      data: [
        { user_id: 'u1', status: 'new' },
        { user_id: 'u1', status: 'new' },
        { user_id: 'u1', status: 'actioned' },
        { user_id: 'u2', status: 'seen' },
      ],
      error: null,
    }
    actionStateResult = {
      data: [
        { user_id: 'u1', status: 'done' },
        { user_id: 'u1', status: 'active' },
        { user_id: 'u2', status: 'active' },
      ],
      error: null,
    }

    const result = await getTeamActivitySummary(['u1', 'u2'])
    expect(result.get('u1')).toEqual({ newSignals: 2, actionedSignals: 1, actionsDone: 1, actionsPending: 1 })
    // 'seen' counts toward neither newSignals nor actionedSignals — only
    // 'new' and 'actioned' are meaningful buckets for this summary.
    expect(result.get('u2')).toEqual({ newSignals: 0, actionedSignals: 0, actionsDone: 0, actionsPending: 1 })
  })

  it('ignores rows for a user_id that was not in the requested id list', async () => {
    signalsResult = { data: [{ user_id: 'someone-else', status: 'new' }], error: null }
    const result = await getTeamActivitySummary(['u1'])
    expect(result.get('u1')).toEqual({ newSignals: 0, actionedSignals: 0, actionsDone: 0, actionsPending: 0 })
    expect(result.has('someone-else')).toBe(false)
  })

  it('queries both tables scoped to the requested ids', async () => {
    await getTeamActivitySummary(['u1', 'u2'])
    expect(fromMock).toHaveBeenCalledWith('intelligence_signals')
    expect(fromMock).toHaveBeenCalledWith('todays_action_state')
  })

  // 2026-08-26 audit fix: either query's error used to be discarded — a
  // failed query silently produced an all-zero summary row indistinguishable
  // from a team that's genuinely had no activity this week.
  it('throws when the signals query errors, instead of silently returning a zeroed summary', async () => {
    signalsResult = { data: null, error: { message: 'signals db down' } }
    await expect(getTeamActivitySummary(['u1'])).rejects.toEqual({ message: 'signals db down' })
  })

  it('throws when the action-state query errors, instead of silently returning a zeroed summary', async () => {
    actionStateResult = { data: null, error: { message: 'action-state db down' } }
    await expect(getTeamActivitySummary(['u1'])).rejects.toEqual({ message: 'action-state db down' })
  })
})
