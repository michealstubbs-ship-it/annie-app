import { describe, it, expect, vi, beforeEach } from 'vitest'

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }))
vi.mock('../supabase', () => ({ supabase: { from: fromMock } }))

import {
  listPipelineActivity,
  listMeetingsInPeriod,
  listTermsDocsInPeriod,
  listInvoicesInPeriod,
  listSplitsForInvoices,
  getJobOwnersByIds,
  listLiveJobsForPerformance,
  loadTeamPerformanceData,
} from './teamPerformance.js'

function makeBuilder(result) {
  const builder = {}
  const chain = () => builder
  Object.assign(builder, {
    select: vi.fn(chain),
    eq: vi.fn(chain),
    gte: vi.fn(chain),
    neq: vi.fn(chain),
    in: vi.fn(chain),
    order: vi.fn(chain),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  })
  return builder
}

beforeEach(() => vi.clearAllMocks())

describe('listPipelineActivity', () => {
  it('reads stage/owner_id/stage_changed_at for links changed on or after the period start', async () => {
    const builder = makeBuilder({ data: [{ owner_id: 'u1', stage: 'sourced' }], error: null })
    fromMock.mockReturnValue(builder)
    const result = await listPipelineActivity('2026-06-01T00:00:00.000Z')
    expect(fromMock).toHaveBeenCalledWith('candidate_job_links')
    expect(builder.select).toHaveBeenCalledWith('stage, owner_id, stage_changed_at')
    expect(builder.gte).toHaveBeenCalledWith('stage_changed_at', '2026-06-01T00:00:00.000Z')
    expect(result).toEqual([{ owner_id: 'u1', stage: 'sourced' }])
  })

  it('throws instead of silently returning [] on a Supabase error', async () => {
    fromMock.mockReturnValue(makeBuilder({ data: null, error: { message: 'db down' } }))
    await expect(listPipelineActivity('2026-06-01')).rejects.toEqual({ message: 'db down' })
  })
})

describe('listMeetingsInPeriod', () => {
  it('filters meeting_date by the period start', async () => {
    const builder = makeBuilder({ data: [], error: null })
    fromMock.mockReturnValue(builder)
    await listMeetingsInPeriod('2026-06-01')
    expect(fromMock).toHaveBeenCalledWith('meetings')
    expect(builder.gte).toHaveBeenCalledWith('meeting_date', '2026-06-01')
  })
})

describe('listTermsDocsInPeriod', () => {
  it('filters uploaded_at, joining the company name for display', async () => {
    const builder = makeBuilder({ data: [], error: null })
    fromMock.mockReturnValue(builder)
    await listTermsDocsInPeriod('2026-06-01')
    expect(fromMock).toHaveBeenCalledWith('company_documents')
    expect(builder.select).toHaveBeenCalledWith('id, credited_to, user_id, uploaded_at, company_id, file_name, companies(name)')
    expect(builder.gte).toHaveBeenCalledWith('uploaded_at', '2026-06-01')
  })
})

describe('listInvoicesInPeriod', () => {
  it('filters issue_date and excludes void invoices', async () => {
    const builder = makeBuilder({ data: [], error: null })
    fromMock.mockReturnValue(builder)
    await listInvoicesInPeriod('2026-06-01')
    expect(fromMock).toHaveBeenCalledWith('invoices')
    expect(builder.gte).toHaveBeenCalledWith('issue_date', '2026-06-01')
    expect(builder.neq).toHaveBeenCalledWith('status', 'void')
  })
})

describe('listSplitsForInvoices', () => {
  it('returns an empty Map without querying when given no invoice ids', async () => {
    const result = await listSplitsForInvoices([])
    expect(fromMock).not.toHaveBeenCalled()
    expect(result).toEqual(new Map())
  })

  it('groups splits by invoice_id', async () => {
    const builder = makeBuilder({
      data: [
        { invoice_id: 'inv1', user_id: 'u1', split_pct: 60 },
        { invoice_id: 'inv1', user_id: 'u2', split_pct: 40 },
        { invoice_id: 'inv2', user_id: 'u1', split_pct: 100 },
      ],
      error: null,
    })
    fromMock.mockReturnValue(builder)
    const result = await listSplitsForInvoices(['inv1', 'inv2'])
    expect(builder.in).toHaveBeenCalledWith('invoice_id', ['inv1', 'inv2'])
    expect(result.get('inv1')).toEqual([
      { invoice_id: 'inv1', user_id: 'u1', split_pct: 60 },
      { invoice_id: 'inv1', user_id: 'u2', split_pct: 40 },
    ])
    expect(result.get('inv2')).toEqual([{ invoice_id: 'inv2', user_id: 'u1', split_pct: 100 }])
  })
})

describe('getJobOwnersByIds', () => {
  it('returns an empty Map without querying when given no job ids', async () => {
    const result = await getJobOwnersByIds([])
    expect(fromMock).not.toHaveBeenCalled()
    expect(result).toEqual(new Map())
  })

  it('maps job id to owner_id', async () => {
    const builder = makeBuilder({ data: [{ id: 'j1', owner_id: 'u1' }, { id: 'j2', owner_id: 'u2' }], error: null })
    fromMock.mockReturnValue(builder)
    const result = await getJobOwnersByIds(['j1', 'j2'])
    expect(builder.in).toHaveBeenCalledWith('id', ['j1', 'j2'])
    expect(result.get('j1')).toBe('u1')
    expect(result.get('j2')).toBe('u2')
  })
})

describe('listLiveJobsForPerformance', () => {
  it('reads only active/onhold jobs, the same definition Companies.jsx already uses for open jobs', async () => {
    const builder = makeBuilder({ data: [], error: null })
    fromMock.mockReturnValue(builder)
    await listLiveJobsForPerformance()
    expect(fromMock).toHaveBeenCalledWith('jobs')
    expect(builder.in).toHaveBeenCalledWith('status', ['active', 'onhold'])
  })
})

describe('loadTeamPerformanceData', () => {
  it('fetches everything computeTeamPerformance needs, splits/job-owners scoped to the invoices actually returned', async () => {
    const pipelineBuilder = makeBuilder({ data: [], error: null })
    const meetingsBuilder = makeBuilder({ data: [], error: null })
    const termsBuilder = makeBuilder({ data: [], error: null })
    const invoicesBuilder = makeBuilder({ data: [{ id: 'inv1', job_id: 'j1', total: 500, currency: 'AED' }], error: null })
    const liveJobsBuilder = makeBuilder({ data: [], error: null })
    const splitsBuilder = makeBuilder({ data: [], error: null })
    const jobOwnersBuilder = makeBuilder({ data: [{ id: 'j1', owner_id: 'u1' }], error: null })

    let jobsCallCount = 0
    fromMock.mockImplementation(table => {
      if (table === 'candidate_job_links') return pipelineBuilder
      if (table === 'meetings') return meetingsBuilder
      if (table === 'company_documents') return termsBuilder
      if (table === 'invoices') return invoicesBuilder
      if (table === 'jobs') {
        jobsCallCount += 1
        // listLiveJobsForPerformance runs in the first Promise.all batch;
        // getJobOwnersByIds only runs after invoices resolves, in the
        // second batch. So the first 'jobs' call is always the live-jobs
        // read and the second is always the owner lookup.
        return jobsCallCount === 1 ? liveJobsBuilder : jobOwnersBuilder
      }
      if (table === 'invoice_splits') return splitsBuilder
      throw new Error(`unexpected table: ${table}`)
    })

    const result = await loadTeamPerformanceData('2026-06-01')
    expect(result.invoices).toEqual([{ id: 'inv1', job_id: 'j1', total: 500, currency: 'AED' }])
    expect(result.jobOwnerById).toBeInstanceOf(Map)
    expect(result.splitsByInvoiceId).toBeInstanceOf(Map)
  })
})
