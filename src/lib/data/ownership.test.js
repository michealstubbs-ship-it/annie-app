import { describe, it, expect, vi, beforeEach } from 'vitest'

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }))
const { reportClientErrorMock } = vi.hoisted(() => ({ reportClientErrorMock: vi.fn() }))
vi.mock('../supabase', () => ({ supabase: { from: fromMock } }))
vi.mock('../errorReporting', () => ({ reportClientError: reportClientErrorMock }))

import { reassignOwner, getOwnershipHistory } from './ownership.js'

function makeBuilder(result) {
  const builder = {}
  const chain = () => builder
  Object.assign(builder, {
    select: vi.fn(chain),
    eq: vi.fn(chain),
    order: vi.fn(chain),
    update: vi.fn(chain),
    insert: vi.fn(chain),
    single: vi.fn(chain),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  })
  return builder
}

beforeEach(() => vi.clearAllMocks())

describe('reassignOwner', () => {
  it('rejects an unknown table before ever calling Supabase', async () => {
    await expect(reassignOwner('deals', 'r1', 'u2', 'actor1', 'u1')).rejects.toThrow('Unknown ownership table')
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('requires a new owner to be given', async () => {
    await expect(reassignOwner('candidates', 'r1', '', 'actor1', 'u1')).rejects.toThrow('Pick who this should be reassigned to')
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('updates owner_id on the record, then logs the change against that record\'s own team_id', async () => {
    const updateBuilder = makeBuilder({ data: { id: 'r1', owner_id: 'u2', team_id: 'team1' }, error: null })
    const historyBuilder = makeBuilder({ data: null, error: null })
    fromMock.mockReturnValueOnce(updateBuilder).mockReturnValueOnce(historyBuilder)

    const result = await reassignOwner('candidates', 'r1', 'u2', 'actor1', 'u1')

    expect(fromMock).toHaveBeenNthCalledWith(1, 'candidates')
    expect(updateBuilder.update).toHaveBeenCalledWith({ owner_id: 'u2' })
    expect(updateBuilder.eq).toHaveBeenCalledWith('id', 'r1')

    expect(fromMock).toHaveBeenNthCalledWith(2, 'ownership_history')
    expect(historyBuilder.insert).toHaveBeenCalledWith({
      team_id: 'team1', table_name: 'candidates', record_id: 'r1', from_owner_id: 'u1', to_owner_id: 'u2', changed_by: 'actor1',
    })
    expect(result).toEqual({ id: 'r1', owner_id: 'u2', team_id: 'team1' })
    expect(reportClientErrorMock).not.toHaveBeenCalled()
  })

  it('logs from_owner_id as null when there was no previous owner', async () => {
    const updateBuilder = makeBuilder({ data: { id: 'r1', owner_id: 'u2', team_id: 'team1' }, error: null })
    const historyBuilder = makeBuilder({ data: null, error: null })
    fromMock.mockReturnValueOnce(updateBuilder).mockReturnValueOnce(historyBuilder)
    await reassignOwner('candidates', 'r1', 'u2', 'actor1', null)
    expect(historyBuilder.insert).toHaveBeenCalledWith(expect.objectContaining({ from_owner_id: null }))
  })

  it('throws when the update itself fails, and never attempts to log history', async () => {
    const updateBuilder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValueOnce(updateBuilder)
    await expect(reassignOwner('candidates', 'r1', 'u2', 'actor1', 'u1')).rejects.toEqual({ message: 'db down' })
    expect(fromMock).toHaveBeenCalledTimes(1)
  })

  // The reassignment itself is the thing the user is waiting on and must
  // succeed/reflect regardless — losing the audit-trail row is a real but
  // secondary problem, reported rather than either swallowed or allowed to
  // fail the whole reassignment (same "best-effort side effect" precedent
  // as Candidates.jsx's maybeLogPlacement).
  it('still returns the updated record when only the history log fails, but reports it', async () => {
    const updateBuilder = makeBuilder({ data: { id: 'r1', owner_id: 'u2', team_id: 'team1' }, error: null })
    const historyBuilder = makeBuilder({ data: null, error: { message: 'history insert failed' } })
    fromMock.mockReturnValueOnce(updateBuilder).mockReturnValueOnce(historyBuilder)

    const result = await reassignOwner('candidates', 'r1', 'u2', 'actor1', 'u1')

    expect(result).toEqual({ id: 'r1', owner_id: 'u2', team_id: 'team1' })
    expect(reportClientErrorMock).toHaveBeenCalledWith(
      'Ownership reassigned but history log failed',
      expect.anything(),
      { table: 'candidates', recordId: 'r1', newOwnerId: 'u2' }
    )
  })
})

describe('reassignOwner — 2026-09-03 candidate_job_links extension', () => {
  it('accepts candidate_job_links as a known ownership table (Job Pipeline entries)', async () => {
    const updateBuilder = makeBuilder({ data: { id: 'link1', owner_id: 'u2', team_id: 'team1' }, error: null })
    const historyBuilder = makeBuilder({ data: null, error: null })
    fromMock.mockReturnValueOnce(updateBuilder).mockReturnValueOnce(historyBuilder)
    const result = await reassignOwner('candidate_job_links', 'link1', 'u2', 'actor1', 'u1')
    expect(fromMock).toHaveBeenNthCalledWith(1, 'candidate_job_links')
    expect(result).toEqual({ id: 'link1', owner_id: 'u2', team_id: 'team1' })
  })
})

describe('getOwnershipHistory', () => {
  it('rejects an unknown table before ever calling Supabase', async () => {
    await expect(getOwnershipHistory('deals', 'r1')).rejects.toThrow('Unknown ownership table')
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('reads every reassignment for one record, newest first', async () => {
    const builder = makeBuilder({ data: [{ id: 'h1' }], error: null })
    fromMock.mockReturnValueOnce(builder)
    const result = await getOwnershipHistory('contacts', 'r1')
    expect(fromMock).toHaveBeenCalledWith('ownership_history')
    expect(builder.eq).toHaveBeenCalledWith('table_name', 'contacts')
    expect(builder.eq).toHaveBeenCalledWith('record_id', 'r1')
    expect(builder.order).toHaveBeenCalledWith('changed_at', { ascending: false })
    expect(result).toEqual([{ id: 'h1' }])
  })

  it('returns an empty array rather than null when there are no rows', async () => {
    const builder = makeBuilder({ data: null, error: null })
    fromMock.mockReturnValueOnce(builder)
    expect(await getOwnershipHistory('contacts', 'r1')).toEqual([])
  })

  it('throws instead of silently returning [] when Supabase reports an error', async () => {
    const builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValueOnce(builder)
    await expect(getOwnershipHistory('contacts', 'r1')).rejects.toEqual({ message: 'db down' })
  })
})
