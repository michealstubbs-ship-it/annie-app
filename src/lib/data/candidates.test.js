import { describe, it, expect, vi, beforeEach } from 'vitest'

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }))
vi.mock('../supabase', () => ({ supabase: { from: fromMock } }))

import { listCandidatesWithJobs, createCandidate, updateCandidate, deleteCandidate, listCandidatesForMatching, listCandidatesMinimal, listCandidatesForInvoicePicker, findCandidateDuplicateByEmail, findDuplicateSubmission, findCandidateIdByExactName } from './candidates.js'

function makeBuilder(result) {
  const builder = {}
  const chain = () => builder
  Object.assign(builder, {
    select: vi.fn(chain),
    eq: vi.fn(chain),
    not: vi.fn(chain),
    order: vi.fn(chain),
    insert: vi.fn(chain),
    update: vi.fn(chain),
    delete: vi.fn(chain),
    ilike: vi.fn(chain),
    limit: vi.fn(chain),
    single: vi.fn(chain),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  })
  return builder
}

let builder

beforeEach(() => {
  vi.clearAllMocks()
  builder = makeBuilder({ data: null, error: null })
  fromMock.mockReturnValue(builder)
})

describe('listCandidatesWithJobs', () => {
  it('joins the linked job and its company, team-scoped by RLS with no client-side user_id filter', async () => {
    builder = makeBuilder({ data: [{ id: 'cand1' }], error: null })
    fromMock.mockReturnValue(builder)
    const result = await listCandidatesWithJobs('user_1')
    expect(fromMock).toHaveBeenCalledWith('candidates')
    expect(builder.select).toHaveBeenCalledWith('*, jobs(title, companies(name))')
    expect(builder.eq).not.toHaveBeenCalledWith('user_id', expect.anything())
    expect(builder.order).toHaveBeenCalledWith('created_at', { ascending: false })
    expect(result).toEqual([{ id: 'cand1' }])
  })

  it('returns an empty array rather than null when there are no rows', async () => {
    expect(await listCandidatesWithJobs('user_1')).toEqual([])
  })

  it('throws instead of silently returning [] when Supabase reports an error', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(listCandidatesWithJobs('user_1')).rejects.toEqual({ message: 'db down' })
  })
})

describe('createCandidate', () => {
  it('stamps the given user_id onto the row', async () => {
    await createCandidate({ name: 'Jo' }, 'user_1')
    expect(builder.insert).toHaveBeenCalledWith({ name: 'Jo', user_id: 'user_1' })
  })

  // 2026-09-07: this used to just fire the insert with no select(). See
  // this function's own header comment for why the fresh id is now needed.
  it('selects its own insert back, so the caller gets the new row (including its id)', async () => {
    builder = makeBuilder({ data: { id: 'new-cand-1', name: 'Jo' }, error: null })
    fromMock.mockReturnValue(builder)
    const { data, error } = await createCandidate({ name: 'Jo' }, 'user_1')
    expect(builder.select).toHaveBeenCalled()
    expect(builder.single).toHaveBeenCalled()
    expect(data).toEqual({ id: 'new-cand-1', name: 'Jo' })
    expect(error).toBeNull()
  })
})

describe('updateCandidate', () => {
  it('targets the row by id', async () => {
    await updateCandidate('cand1', { name: 'Jo' })
    expect(builder.update).toHaveBeenCalledWith({ name: 'Jo' })
    expect(builder.eq).toHaveBeenCalledWith('id', 'cand1')
  })
})

describe('deleteCandidate', () => {
  it('targets the row by id', async () => {
    await deleteCandidate('cand1')
    expect(builder.delete).toHaveBeenCalled()
    expect(builder.eq).toHaveBeenCalledWith('id', 'cand1')
  })
})

describe('listCandidatesForMatching', () => {
  it('is team-scoped by RLS with the matching-relevant fields, including company and notes for the pipeline-match display, no client-side user_id filter', async () => {
    await listCandidatesForMatching('user_1')
    expect(builder.select).toHaveBeenCalledWith('id, name, role, industry, status, company, notes')
    expect(builder.eq).not.toHaveBeenCalledWith('user_id', expect.anything())
  })

  it('throws instead of silently returning [] when Supabase reports an error', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(listCandidatesForMatching('user_1')).rejects.toEqual({ message: 'db down' })
  })
})

describe('listCandidatesMinimal', () => {
  it('is team-scoped by RLS, orders by name, no client-side user_id filter', async () => {
    await listCandidatesMinimal('user_1')
    expect(builder.select).toHaveBeenCalledWith('id, name')
    expect(builder.eq).not.toHaveBeenCalledWith('user_id', expect.anything())
    expect(builder.order).toHaveBeenCalledWith('name')
  })

  it('throws instead of silently returning [] when Supabase reports an error', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(listCandidatesMinimal('user_1')).rejects.toEqual({ message: 'db down' })
  })
})

describe('findCandidateDuplicateByEmail', () => {
  it('returns null without querying when no email is given', async () => {
    const result = await findCandidateDuplicateByEmail('')
    expect(result).toBeNull()
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('looks up by case-insensitive email and returns the match', async () => {
    builder = makeBuilder({ data: { id: 'cand1', name: 'Jane Doe', owner_id: 'user_2', created_at: '2026-08-01' }, error: null })
    fromMock.mockReturnValue(builder)
    const result = await findCandidateDuplicateByEmail('Jane@Example.com')
    expect(fromMock).toHaveBeenCalledWith('candidates')
    expect(builder.select).toHaveBeenCalledWith('id, name, owner_id, created_at')
    expect(builder.ilike).toHaveBeenCalledWith('email', 'Jane@Example.com')
    expect(builder.limit).toHaveBeenCalledWith(1)
    expect(result).toEqual({ id: 'cand1', name: 'Jane Doe', owner_id: 'user_2', created_at: '2026-08-01' })
  })

  it('returns null when nothing matches', async () => {
    builder = makeBuilder({ data: null, error: null })
    fromMock.mockReturnValue(builder)
    expect(await findCandidateDuplicateByEmail('nobody@example.com')).toBeNull()
  })

  it('throws instead of silently returning null when Supabase reports an error', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(findCandidateDuplicateByEmail('jane@example.com')).rejects.toEqual({ message: 'db down' })
  })
})

describe('findCandidateIdByExactName', () => {
  it('returns null without querying when no name is given', async () => {
    expect(await findCandidateIdByExactName('')).toBeNull()
    expect(await findCandidateIdByExactName('   ')).toBeNull()
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('looks up by case-insensitive name and returns the id', async () => {
    builder = makeBuilder({ data: { id: 'cand9' }, error: null })
    fromMock.mockReturnValue(builder)
    const result = await findCandidateIdByExactName('Jane Doe')
    expect(fromMock).toHaveBeenCalledWith('candidates')
    expect(builder.ilike).toHaveBeenCalledWith('name', 'Jane Doe')
    expect(result).toBe('cand9')
  })

  it('returns null when no candidate matches', async () => {
    builder = makeBuilder({ data: null, error: null })
    fromMock.mockReturnValue(builder)
    expect(await findCandidateIdByExactName('Nobody Here')).toBeNull()
  })

  it('throws instead of silently returning null when Supabase reports an error', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(findCandidateIdByExactName('Jane Doe')).rejects.toEqual({ message: 'db down' })
  })
})

// 2026-09-03, Michael ("double-submission warnings")
describe('findDuplicateSubmission', () => {
  it('returns null without querying when no email is given', async () => {
    expect(await findDuplicateSubmission('', 'job1')).toBeNull()
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('returns null without querying when no jobId is given', async () => {
    expect(await findDuplicateSubmission('jane@example.com', '')).toBeNull()
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('looks up by case-insensitive email SCOPED to the given job, and returns the match', async () => {
    builder = makeBuilder({ data: { id: 'cand1', name: 'Jane Doe', owner_id: 'user_2', status: 'submitted', created_at: '2026-08-01' }, error: null })
    fromMock.mockReturnValue(builder)
    const result = await findDuplicateSubmission('Jane@Example.com', 'job1')
    expect(fromMock).toHaveBeenCalledWith('candidates')
    expect(builder.select).toHaveBeenCalledWith('id, name, owner_id, status, created_at')
    expect(builder.ilike).toHaveBeenCalledWith('email', 'Jane@Example.com')
    expect(builder.eq).toHaveBeenCalledWith('job_id', 'job1')
    expect(builder.limit).toHaveBeenCalledWith(1)
    expect(result).toEqual({ id: 'cand1', name: 'Jane Doe', owner_id: 'user_2', status: 'submitted', created_at: '2026-08-01' })
  })

  it('returns null when this candidate has not been submitted to this particular job', async () => {
    builder = makeBuilder({ data: null, error: null })
    fromMock.mockReturnValue(builder)
    expect(await findDuplicateSubmission('jane@example.com', 'job1')).toBeNull()
  })

  it('throws instead of silently returning null when Supabase reports an error', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(findDuplicateSubmission('jane@example.com', 'job1')).rejects.toEqual({ message: 'db down' })
  })
})

describe('listCandidatesForInvoicePicker', () => {
  it('selects enough fields for the invoice job/status filter, orders by name, no client-side user_id filter', async () => {
    await listCandidatesForInvoicePicker()
    expect(fromMock).toHaveBeenCalledWith('candidates')
    expect(builder.select).toHaveBeenCalledWith('id, name, job_id, status')
    expect(builder.eq).not.toHaveBeenCalledWith('user_id', expect.anything())
    expect(builder.order).toHaveBeenCalledWith('name')
  })

  it('throws instead of silently returning [] when Supabase reports an error', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(listCandidatesForInvoicePicker()).rejects.toEqual({ message: 'db down' })
  })
})
