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
  it('is team-scoped by RLS and returns an empty array rather than null, no client-side user_id filter', async () => {
    const result = await listJobsMinimal('user_1')
    expect(fromMock).toHaveBeenCalledWith('jobs')
    expect(builder.eq).not.toHaveBeenCalledWith('user_id', expect.anything())
    expect(result).toEqual([])
  })

  it('throws instead of silently returning [] when Supabase reports an error', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(listJobsMinimal('user_1')).rejects.toEqual({ message: 'db down' })
  })
})

describe('listActiveJobsForPicker', () => {
  it('only includes active/onhold jobs, ordered by title, no client-side user_id filter', async () => {
    await listActiveJobsForPicker('user_1')
    expect(builder.eq).not.toHaveBeenCalledWith('user_id', expect.anything())
    expect(builder.in).toHaveBeenCalledWith('status', ['active', 'onhold'])
    expect(builder.order).toHaveBeenCalledWith('title')
  })

  it('throws instead of silently returning [] when Supabase reports an error', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(listActiveJobsForPicker('user_1')).rejects.toEqual({ message: 'db down' })
  })
})

describe('listJobsWithCompanies', () => {
  it('joins the linked company, team-scoped by RLS, newest first, no client-side user_id filter', async () => {
    builder = makeBuilder({ data: [{ id: 'job1' }], error: null })
    fromMock.mockReturnValue(builder)
    const result = await listJobsWithCompanies('user_1')
    expect(fromMock).toHaveBeenCalledWith('jobs')
    expect(builder.select).toHaveBeenCalledWith('*, companies(name, industry, location)')
    expect(builder.eq).not.toHaveBeenCalledWith('user_id', expect.anything())
    expect(builder.order).toHaveBeenCalledWith('created_at', { ascending: false })
    expect(result).toEqual([{ id: 'job1' }])
  })

  it('returns an empty array rather than null when there are no rows', async () => {
    expect(await listJobsWithCompanies('user_1')).toEqual([])
  })

  it('throws instead of silently returning [] when Supabase reports an error', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(listJobsWithCompanies('user_1')).rejects.toEqual({ message: 'db down' })
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
