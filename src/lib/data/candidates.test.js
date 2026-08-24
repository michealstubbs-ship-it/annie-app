import { describe, it, expect, vi, beforeEach } from 'vitest'

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }))
vi.mock('../supabase', () => ({ supabase: { from: fromMock } }))

import { listCandidatesWithJobs, createCandidate, updateCandidate, deleteCandidate, listCandidateJobLinks, listCandidatesForMatching, listCandidatesMinimal } from './candidates.js'

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
})

describe('createCandidate', () => {
  it('stamps the given user_id onto the row', async () => {
    await createCandidate({ name: 'Jo' }, 'user_1')
    expect(builder.insert).toHaveBeenCalledWith({ name: 'Jo', user_id: 'user_1' })
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

describe('listCandidateJobLinks', () => {
  it('excludes candidates with no job_id, no client-side user_id filter', async () => {
    builder = makeBuilder({ data: [{ job_id: 'job1' }], error: null })
    fromMock.mockReturnValue(builder)
    const result = await listCandidateJobLinks('user_1')
    expect(builder.select).toHaveBeenCalledWith('job_id')
    expect(builder.eq).not.toHaveBeenCalledWith('user_id', expect.anything())
    expect(builder.not).toHaveBeenCalledWith('job_id', 'is', null)
    expect(result).toEqual([{ job_id: 'job1' }])
  })
})

describe('listCandidatesForMatching', () => {
  it('is team-scoped by RLS with the matching-relevant fields, including company and notes for the pipeline-match display, no client-side user_id filter', async () => {
    await listCandidatesForMatching('user_1')
    expect(builder.select).toHaveBeenCalledWith('id, name, role, industry, status, company, notes')
    expect(builder.eq).not.toHaveBeenCalledWith('user_id', expect.anything())
  })
})

describe('listCandidatesMinimal', () => {
  it('is team-scoped by RLS, orders by name, no client-side user_id filter', async () => {
    await listCandidatesMinimal('user_1')
    expect(builder.select).toHaveBeenCalledWith('id, name')
    expect(builder.eq).not.toHaveBeenCalledWith('user_id', expect.anything())
    expect(builder.order).toHaveBeenCalledWith('name')
  })
})
