import { describe, it, expect, vi, beforeEach } from 'vitest'

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }))
vi.mock('../supabase', () => ({ supabase: { from: fromMock } }))

import { listJobsMinimal, listActiveJobsForPicker, listJobsWithCompanies, createJob, updateJob, deleteJob } from './jobs.js'

function makeBuilder(result) {
  const builder = {}
  const chain = () => builder
  Object.assign(builder, {
    select: vi.fn(chain),
    eq: vi.fn(chain),
    in: vi.fn(chain),
    order: vi.fn(chain),
    insert: vi.fn(chain),
    update: vi.fn(chain),
    delete: vi.fn(chain),
    single: vi.fn(chain),
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

describe('listJobsMinimal', () => {
  it('scopes to the given user and returns an empty array rather than null', async () => {
    const result = await listJobsMinimal('user_1')
    expect(fromMock).toHaveBeenCalledWith('jobs')
    expect(builder.eq).toHaveBeenCalledWith('user_id', 'user_1')
    expect(result).toEqual([])
  })
})

describe('listActiveJobsForPicker', () => {
  it('only includes active/onhold jobs, ordered by title', async () => {
    await listActiveJobsForPicker('user_1')
    expect(builder.eq).toHaveBeenCalledWith('user_id', 'user_1')
    expect(builder.in).toHaveBeenCalledWith('status', ['active', 'onhold'])
    expect(builder.order).toHaveBeenCalledWith('title')
  })
})

describe('listJobsWithCompanies', () => {
  it('joins the linked company, scoped to the given user, newest first', async () => {
    builder = makeBuilder({ data: [{ id: 'job1' }], error: null })
    fromMock.mockReturnValue(builder)
    const result = await listJobsWithCompanies('user_1')
    expect(fromMock).toHaveBeenCalledWith('jobs')
    expect(builder.select).toHaveBeenCalledWith('*, companies(name, industry, location)')
    expect(builder.eq).toHaveBeenCalledWith('user_id', 'user_1')
    expect(builder.order).toHaveBeenCalledWith('created_at', { ascending: false })
    expect(result).toEqual([{ id: 'job1' }])
  })

  it('returns an empty array rather than null when there are no rows', async () => {
    expect(await listJobsWithCompanies('user_1')).toEqual([])
  })
})

describe('createJob', () => {
  it('stamps the given user_id onto the row', async () => {
    await createJob({ title: 'Recruiter' }, 'user_1')
    expect(builder.insert).toHaveBeenCalledWith({ title: 'Recruiter', user_id: 'user_1' })
  })
})

describe('updateJob', () => {
  it('targets the row by id', async () => {
    await updateJob('job1', { title: 'Recruiter' })
    expect(builder.update).toHaveBeenCalledWith({ title: 'Recruiter' })
    expect(builder.eq).toHaveBeenCalledWith('id', 'job1')
  })
})

describe('deleteJob', () => {
  it('targets the row by id', async () => {
    await deleteJob('job1')
    expect(builder.delete).toHaveBeenCalled()
    expect(builder.eq).toHaveBeenCalledWith('id', 'job1')
  })
})
