import { describe, it, expect, vi, beforeEach } from 'vitest'

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }))
vi.mock('../supabase', () => ({ supabase: { from: fromMock } }))

import { listJobsMinimal, listActiveJobsForPicker, listJobsWithCompanies, listJobsForCompany, listJobsForPipelineSummary, getJob, createJob, updateJob, deleteJob, markJobFilledIfOpen } from './jobs.js'

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
    maybeSingle: vi.fn(chain),
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

describe('listJobsForCompany', () => {
  it('filters to the given company, includes fee_value, newest first', async () => {
    builder = makeBuilder({ data: [{ id: 'job1', fee_value: 15000 }], error: null })
    fromMock.mockReturnValue(builder)
    const result = await listJobsForCompany('co1')
    expect(fromMock).toHaveBeenCalledWith('jobs')
    expect(builder.select).toHaveBeenCalledWith('id, title, status, fee_value')
    expect(builder.eq).toHaveBeenCalledWith('company_id', 'co1')
    expect(builder.order).toHaveBeenCalledWith('created_at', { ascending: false })
    expect(result).toEqual([{ id: 'job1', fee_value: 15000 }])
  })

  it('throws instead of silently returning [] when Supabase reports an error', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(listJobsForCompany('co1')).rejects.toEqual({ message: 'db down' })
  })
})

describe('listJobsForPipelineSummary', () => {
  it('reads only status and fee_value, team-scoped by RLS with no client-side filter', async () => {
    builder = makeBuilder({ data: [{ status: 'active', fee_value: 15000 }], error: null })
    fromMock.mockReturnValue(builder)
    const result = await listJobsForPipelineSummary()
    expect(fromMock).toHaveBeenCalledWith('jobs')
    expect(builder.select).toHaveBeenCalledWith('status, fee_value')
    expect(builder.eq).not.toHaveBeenCalled()
    expect(result).toEqual([{ status: 'active', fee_value: 15000 }])
  })

  it('returns an empty array rather than null when there are no rows', async () => {
    expect(await listJobsForPipelineSummary()).toEqual([])
  })

  it('throws instead of silently returning [] when Supabase reports an error', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(listJobsForPipelineSummary()).rejects.toEqual({ message: 'db down' })
  })
})

describe('getJob', () => {
  it('reads one job by id, joining its linked company', async () => {
    builder = makeBuilder({ data: { id: 'job1', title: 'CFO', companies: { name: 'Acme' } }, error: null })
    fromMock.mockReturnValue(builder)
    const result = await getJob('job1')
    expect(fromMock).toHaveBeenCalledWith('jobs')
    expect(builder.select).toHaveBeenCalledWith('*, companies(name)')
    expect(builder.eq).toHaveBeenCalledWith('id', 'job1')
    expect(result).toEqual({ id: 'job1', title: 'CFO', companies: { name: 'Acme' } })
  })

  it('throws when Supabase reports an error', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(getJob('job1')).rejects.toEqual({ message: 'db down' })
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

// 2026-09-07, gap-analysis batch 8: a candidate marked Placed used to
// never flip their own job to 'filled', anywhere. See this function's own
// header comment in jobs.js for the full reasoning and both real call
// sites (Candidates.jsx's own status field, and the pipeline board's
// updatePipelineLinkStage in pipelineLinks.js).
describe('markJobFilledIfOpen', () => {
  it('does nothing, makes no Supabase call at all, when jobId is falsy', async () => {
    await markJobFilledIfOpen(null)
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('flips an active job to filled', async () => {
    builder = makeBuilder({ data: { id: 'job1', status: 'active' }, error: null })
    fromMock.mockReturnValue(builder)
    await markJobFilledIfOpen('job1')
    expect(fromMock).toHaveBeenCalledTimes(2)
    expect(builder.select).toHaveBeenCalledWith('id, status')
    expect(builder.eq).toHaveBeenCalledWith('id', 'job1')
    expect(builder.update).toHaveBeenCalledWith({ status: 'filled' })
  })

  it('flips an onhold job to filled too', async () => {
    builder = makeBuilder({ data: { id: 'job1', status: 'onhold' }, error: null })
    fromMock.mockReturnValue(builder)
    await markJobFilledIfOpen('job1')
    expect(builder.update).toHaveBeenCalledWith({ status: 'filled' })
  })

  it('is a no-op for a job that is already filled, no update call', async () => {
    builder = makeBuilder({ data: { id: 'job1', status: 'filled' }, error: null })
    fromMock.mockReturnValue(builder)
    await markJobFilledIfOpen('job1')
    expect(fromMock).toHaveBeenCalledTimes(1)
    expect(builder.update).not.toHaveBeenCalled()
  })

  it('never overwrites a job a recruiter separately marked lost', async () => {
    builder = makeBuilder({ data: { id: 'job1', status: 'lost' }, error: null })
    fromMock.mockReturnValue(builder)
    await markJobFilledIfOpen('job1')
    expect(fromMock).toHaveBeenCalledTimes(1)
    expect(builder.update).not.toHaveBeenCalled()
  })

  it('is a no-op when the job cannot be found', async () => {
    builder = makeBuilder({ data: null, error: null })
    fromMock.mockReturnValue(builder)
    await markJobFilledIfOpen('job1')
    expect(fromMock).toHaveBeenCalledTimes(1)
    expect(builder.update).not.toHaveBeenCalled()
  })

  it('throws when the fetch itself errors', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(markJobFilledIfOpen('job1')).rejects.toEqual({ message: 'db down' })
  })
})
