import { describe, it, expect, vi, beforeEach } from 'vitest'

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }))
vi.mock('../supabase', () => ({ supabase: { from: fromMock } }))

import { listSplitsForInvoice, validateSplits, replaceSplits } from './invoiceSplits.js'

function makeBuilder(result) {
  const builder = {}
  const chain = () => builder
  Object.assign(builder, {
    select: vi.fn(chain),
    eq: vi.fn(chain),
    order: vi.fn(chain),
    delete: vi.fn(chain),
    insert: vi.fn(chain),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  })
  return builder
}

beforeEach(() => vi.clearAllMocks())

describe('listSplitsForInvoice', () => {
  it('reads every split for one invoice', async () => {
    const builder = makeBuilder({ data: [{ id: 's1' }], error: null })
    fromMock.mockReturnValue(builder)
    const result = await listSplitsForInvoice('inv1')
    expect(fromMock).toHaveBeenCalledWith('invoice_splits')
    expect(builder.eq).toHaveBeenCalledWith('invoice_id', 'inv1')
    expect(result).toEqual([{ id: 's1' }])
  })

  it('returns an empty array rather than null when there are no rows', async () => {
    const builder = makeBuilder({ data: null, error: null })
    fromMock.mockReturnValue(builder)
    expect(await listSplitsForInvoice('inv1')).toEqual([])
  })

  it('throws instead of silently returning [] when Supabase reports an error', async () => {
    const builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(listSplitsForInvoice('inv1')).rejects.toEqual({ message: 'db down' })
  })
})

describe('validateSplits', () => {
  it('accepts an empty split list (nothing entered yet)', () => {
    expect(validateSplits([])).toBeNull()
    expect(validateSplits(null)).toBeNull()
  })

  it('requires a team member on every split', () => {
    expect(validateSplits([{ roleType: 'candidate_owner', splitPct: 100 }])).toMatch(/team member/)
  })

  it('requires a positive percentage on every split', () => {
    expect(validateSplits([{ userId: 'u1', roleType: 'candidate_owner', splitPct: 0 }])).toMatch(/percentage/)
  })

  it('rejects an unknown role type', () => {
    expect(validateSplits([{ userId: 'u1', roleType: 'sourcer', splitPct: 100 }])).toMatch(/Unknown split role/)
  })

  it('requires candidate_owner splits to sum to 100% when any are entered', () => {
    expect(validateSplits([{ userId: 'u1', roleType: 'candidate_owner', splitPct: 60 }])).toMatch(/Candidate-owner.*100%/)
  })

  it('requires job_owner splits to sum to 100% when any are entered', () => {
    expect(validateSplits([{ userId: 'u1', roleType: 'job_owner', splitPct: 40 }])).toMatch(/Job-owner.*100%/)
  })

  it('accepts a valid two-person split on one side', () => {
    expect(validateSplits([
      { userId: 'u1', roleType: 'candidate_owner', splitPct: 60 },
      { userId: 'u2', roleType: 'candidate_owner', splitPct: 40 },
    ])).toBeNull()
  })

  it('accepts a valid single-person 100% split each side, independently', () => {
    expect(validateSplits([
      { userId: 'u1', roleType: 'candidate_owner', splitPct: 100 },
      { userId: 'u2', roleType: 'job_owner', splitPct: 100 },
    ])).toBeNull()
  })

  it('does not require the OTHER role to be filled in — only validates roles that have any splits', () => {
    expect(validateSplits([{ userId: 'u1', roleType: 'candidate_owner', splitPct: 100 }])).toBeNull()
  })
})

describe('replaceSplits', () => {
  it('throws before touching Supabase when the splits are invalid', async () => {
    await expect(replaceSplits('inv1', 'team1', [{ userId: 'u1', roleType: 'candidate_owner', splitPct: 60 }]))
      .rejects.toThrow(/100%/)
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('deletes the existing set then inserts the new rows, stamping invoice_id/team_id', async () => {
    const delBuilder = makeBuilder({ data: null, error: null })
    const insBuilder = makeBuilder({ data: [{ id: 's1' }], error: null })
    fromMock.mockReturnValueOnce(delBuilder).mockReturnValueOnce(insBuilder)

    const result = await replaceSplits('inv1', 'team1', [
      { userId: 'u1', roleType: 'candidate_owner', splitPct: 100 },
    ])

    expect(fromMock).toHaveBeenNthCalledWith(1, 'invoice_splits')
    expect(delBuilder.delete).toHaveBeenCalled()
    expect(delBuilder.eq).toHaveBeenCalledWith('invoice_id', 'inv1')
    expect(fromMock).toHaveBeenNthCalledWith(2, 'invoice_splits')
    expect(insBuilder.insert).toHaveBeenCalledWith([
      { invoice_id: 'inv1', team_id: 'team1', user_id: 'u1', role_type: 'candidate_owner', split_pct: 100 },
    ])
    expect(result).toEqual([{ id: 's1' }])
  })

  it('clears all splits (deletes, inserts nothing) when given an empty list', async () => {
    const delBuilder = makeBuilder({ data: null, error: null })
    fromMock.mockReturnValueOnce(delBuilder)
    const result = await replaceSplits('inv1', 'team1', [])
    expect(fromMock).toHaveBeenCalledTimes(1)
    expect(result).toEqual([])
  })

  it('throws when the delete step fails, and never attempts the insert', async () => {
    const delBuilder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValueOnce(delBuilder)
    await expect(replaceSplits('inv1', 'team1', [{ userId: 'u1', roleType: 'candidate_owner', splitPct: 100 }]))
      .rejects.toEqual({ message: 'db down' })
    expect(fromMock).toHaveBeenCalledTimes(1)
  })

  it('throws when the insert step fails', async () => {
    const delBuilder = makeBuilder({ data: null, error: null })
    const insBuilder = makeBuilder({ data: null, error: { message: 'insert failed' } })
    fromMock.mockReturnValueOnce(delBuilder).mockReturnValueOnce(insBuilder)
    await expect(replaceSplits('inv1', 'team1', [{ userId: 'u1', roleType: 'candidate_owner', splitPct: 100 }]))
      .rejects.toEqual({ message: 'insert failed' })
  })
})
