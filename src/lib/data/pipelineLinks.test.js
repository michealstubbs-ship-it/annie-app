import { describe, it, expect, vi, beforeEach } from 'vitest'

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }))
const { updateCandidateMock } = vi.hoisted(() => ({ updateCandidateMock: vi.fn() }))
const { createMeetingMock } = vi.hoisted(() => ({ createMeetingMock: vi.fn() }))
const { markJobFilledIfOpenMock } = vi.hoisted(() => ({ markJobFilledIfOpenMock: vi.fn() }))
vi.mock('../supabase', () => ({ supabase: { from: fromMock } }))
vi.mock('./candidates', () => ({ updateCandidate: updateCandidateMock }))
vi.mock('./meetings', () => ({ createMeeting: createMeetingMock }))
vi.mock('./jobs', () => ({ markJobFilledIfOpen: markJobFilledIfOpenMock }))

import {
  listPipelineForJob,
  listOtherPipelinesForCandidate,
  createPipelineLink,
  updatePipelineLinkStage,
  updatePipelineLinkInterview,
  countPipelinesPerCandidate,
  listCandidatesForPipelinePicker,
  listAllPipelineLinkCounts,
} from './pipelineLinks.js'

function makeBuilder(result) {
  const builder = {}
  const chain = () => builder
  Object.assign(builder, {
    select: vi.fn(chain),
    eq: vi.fn(chain),
    neq: vi.fn(chain),
    in: vi.fn(chain),
    order: vi.fn(chain),
    insert: vi.fn(chain),
    update: vi.fn(chain),
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
  updateCandidateMock.mockResolvedValue({ error: null })
  createMeetingMock.mockResolvedValue({ error: null })
  markJobFilledIfOpenMock.mockResolvedValue(undefined)
})

describe('listPipelineForJob', () => {
  it('joins the candidate, scoped to the given job, newest stage-change first', async () => {
    builder = makeBuilder({ data: [{ id: 'link1' }], error: null })
    fromMock.mockReturnValue(builder)
    const result = await listPipelineForJob('job1')
    expect(fromMock).toHaveBeenCalledWith('candidate_job_links')
    expect(builder.select).toHaveBeenCalledWith('*, candidates(id, name, role, company, want_sal, want_sal_currency, source, email, cv_path)')
    expect(builder.eq).toHaveBeenCalledWith('job_id', 'job1')
    expect(builder.order).toHaveBeenCalledWith('stage_changed_at', { ascending: false })
    expect(result).toEqual([{ id: 'link1' }])
  })

  it('returns an empty array rather than null when there are no rows', async () => {
    expect(await listPipelineForJob('job1')).toEqual([])
  })

  it('throws instead of silently returning [] when Supabase reports an error', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(listPipelineForJob('job1')).rejects.toEqual({ message: 'db down' })
  })
})

describe('listOtherPipelinesForCandidate', () => {
  it('returns [] without querying when no candidateId is given', async () => {
    expect(await listOtherPipelinesForCandidate('', 'job1')).toEqual([])
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('excludes the given job and joins the linked job + its company', async () => {
    builder = makeBuilder({ data: [{ id: 'link2' }], error: null })
    fromMock.mockReturnValue(builder)
    const result = await listOtherPipelinesForCandidate('cand1', 'job1')
    expect(fromMock).toHaveBeenCalledWith('candidate_job_links')
    expect(builder.select).toHaveBeenCalledWith('*, jobs(id, title, companies(name))')
    expect(builder.eq).toHaveBeenCalledWith('candidate_id', 'cand1')
    expect(builder.neq).toHaveBeenCalledWith('job_id', 'job1')
    expect(result).toEqual([{ id: 'link2' }])
  })

  it('does not filter by job when no excludeJobId is given', async () => {
    await listOtherPipelinesForCandidate('cand1', '')
    expect(builder.neq).not.toHaveBeenCalled()
  })

  it('throws instead of silently returning [] when Supabase reports an error', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(listOtherPipelinesForCandidate('cand1', 'job1')).rejects.toEqual({ message: 'db down' })
  })
})

describe('createPipelineLink', () => {
  it('inserts a secondary (non-primary) link stamped with the actor as both added_by and owner_id', async () => {
    builder = makeBuilder({ data: { id: 'link1' }, error: null })
    fromMock.mockReturnValue(builder)
    const result = await createPipelineLink('cand1', 'job1', 'team1', 'user1')
    expect(fromMock).toHaveBeenCalledWith('candidate_job_links')
    expect(builder.insert).toHaveBeenCalledWith({
      candidate_id: 'cand1', job_id: 'job1', team_id: 'team1', is_primary: false, added_by: 'user1', owner_id: 'user1',
    })
    expect(result).toEqual({ id: 'link1' })
  })

  it('throws when Supabase reports an error', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(createPipelineLink('cand1', 'job1', 'team1', 'user1')).rejects.toEqual({ message: 'db down' })
  })
})

describe('updatePipelineLinkStage', () => {
  it('updates the stage and stamps stage_changed_at', async () => {
    builder = makeBuilder({ data: { id: 'link1', stage: 'offer' }, error: null })
    fromMock.mockReturnValue(builder)
    const result = await updatePipelineLinkStage('link1', 'offer')
    expect(builder.update).toHaveBeenCalledWith(expect.objectContaining({ stage: 'offer', stage_changed_at: expect.any(String) }))
    expect(builder.eq).toHaveBeenCalledWith('id', 'link1')
    expect(result).toEqual({ id: 'link1', stage: 'offer' })
    expect(updateCandidateMock).not.toHaveBeenCalled()
  })

  it('also writes candidates.status when this is the primary link', async () => {
    builder = makeBuilder({ data: { id: 'link1', stage: 'offer' }, error: null })
    fromMock.mockReturnValue(builder)
    await updatePipelineLinkStage('link1', 'offer', { isPrimary: true, candidateId: 'cand1' })
    expect(updateCandidateMock).toHaveBeenCalledWith('cand1', { status: 'offer' })
  })

  it('throws when the link update itself fails', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(updatePipelineLinkStage('link1', 'offer')).rejects.toEqual({ message: 'db down' })
    expect(updateCandidateMock).not.toHaveBeenCalled()
  })

  it('throws when the primary-sync candidate write fails', async () => {
    builder = makeBuilder({ data: { id: 'link1', stage: 'offer' }, error: null })
    fromMock.mockReturnValue(builder)
    updateCandidateMock.mockResolvedValue({ error: { message: 'candidate write failed' } })
    await expect(updatePipelineLinkStage('link1', 'offer', { isPrimary: true, candidateId: 'cand1' })).rejects.toEqual({ message: 'candidate write failed' })
  })

  // 2026-09-07, gap-analysis batch 8: the pipeline board is likely the more
  // common place a placement actually happens (a drag to Placed, or the
  // detail panel's "Advance stage" button). See markJobFilledIfOpen's own
  // header comment in jobs.js for why this needed the same job-status side
  // effect Candidates.jsx's own status field already triggers.
  it('marks the job filled when the new stage is placed', async () => {
    builder = makeBuilder({ data: { id: 'link1', stage: 'placed', job_id: 'job1' }, error: null })
    fromMock.mockReturnValue(builder)
    await updatePipelineLinkStage('link1', 'placed')
    expect(markJobFilledIfOpenMock).toHaveBeenCalledWith('job1')
  })

  it('does not touch job status for any stage other than placed', async () => {
    builder = makeBuilder({ data: { id: 'link1', stage: 'interviewing', job_id: 'job1' }, error: null })
    fromMock.mockReturnValue(builder)
    await updatePipelineLinkStage('link1', 'interviewing')
    expect(markJobFilledIfOpenMock).not.toHaveBeenCalled()
  })

  it('propagates an error from markJobFilledIfOpen rather than swallowing it', async () => {
    builder = makeBuilder({ data: { id: 'link1', stage: 'placed', job_id: 'job1' }, error: null })
    fromMock.mockReturnValue(builder)
    markJobFilledIfOpenMock.mockRejectedValue(new Error('jobs write failed'))
    await expect(updatePipelineLinkStage('link1', 'placed')).rejects.toThrow('jobs write failed')
  })
})

describe('updatePipelineLinkInterview', () => {
  it('updates interview_round/interview_at on the link', async () => {
    builder = makeBuilder({ data: { id: 'link1' }, error: null })
    fromMock.mockReturnValue(builder)
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    await updatePipelineLinkInterview('link1', { round: 2, at: future, candidateId: 'cand1', candidateName: 'Jo', jobTitle: 'CFO', userId: 'user1' })
    expect(builder.update).toHaveBeenCalledWith({ interview_round: 2, interview_at: future })
    expect(builder.eq).toHaveBeenCalledWith('id', 'link1')
  })

  it('clears round/at when given none', async () => {
    builder = makeBuilder({ data: { id: 'link1' }, error: null })
    fromMock.mockReturnValue(builder)
    await updatePipelineLinkInterview('link1', {})
    expect(builder.update).toHaveBeenCalledWith({ interview_round: null, interview_at: null })
    expect(createMeetingMock).not.toHaveBeenCalled()
  })

  it('does NOT create a meeting when the interview is not today', async () => {
    builder = makeBuilder({ data: { id: 'link1' }, error: null })
    fromMock.mockReturnValue(builder)
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    await updatePipelineLinkInterview('link1', { at: future, candidateId: 'cand1', candidateName: 'Jo', userId: 'user1' })
    expect(createMeetingMock).not.toHaveBeenCalled()
  })

  it('creates a real meetings row, candidate-linked, when the interview is scheduled for today', async () => {
    builder = makeBuilder({ data: { id: 'link1' }, error: null })
    fromMock.mockReturnValue(builder)
    const todayAt5pm = new Date()
    todayAt5pm.setHours(17, 0, 0, 0)
    await updatePipelineLinkInterview('link1', {
      round: 1, at: todayAt5pm.toISOString(), candidateId: 'cand1', candidateName: 'Jo Bloggs', jobTitle: 'CFO', userId: 'user1',
    })
    expect(createMeetingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Interview (round 1): Jo Bloggs — CFO',
        meeting_type: 'interview',
        meeting_date: todayAt5pm.toISOString(),
        candidate_id: 'cand1',
      }),
      'user1'
    )
  })

  it('throws when the link update itself fails, and never attempts to create a meeting', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(updatePipelineLinkInterview('link1', { at: new Date().toISOString() })).rejects.toEqual({ message: 'db down' })
    expect(createMeetingMock).not.toHaveBeenCalled()
  })

  it('throws when the meeting creation itself fails', async () => {
    builder = makeBuilder({ data: { id: 'link1' }, error: null })
    fromMock.mockReturnValue(builder)
    createMeetingMock.mockResolvedValue({ error: { message: 'meeting insert failed' } })
    const todayAt5pm = new Date()
    todayAt5pm.setHours(17, 0, 0, 0)
    await expect(updatePipelineLinkInterview('link1', { at: todayAt5pm.toISOString(), candidateId: 'cand1', userId: 'user1' })).rejects.toEqual({ message: 'meeting insert failed' })
  })
})

describe('countPipelinesPerCandidate', () => {
  it('returns {} without querying when no candidateIds are given', async () => {
    expect(await countPipelinesPerCandidate([])).toEqual({})
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('counts links per candidate across the given ids', async () => {
    builder = makeBuilder({ data: [{ candidate_id: 'cand1' }, { candidate_id: 'cand1' }, { candidate_id: 'cand2' }], error: null })
    fromMock.mockReturnValue(builder)
    const result = await countPipelinesPerCandidate(['cand1', 'cand2'])
    expect(fromMock).toHaveBeenCalledWith('candidate_job_links')
    expect(builder.select).toHaveBeenCalledWith('candidate_id')
    expect(builder.in).toHaveBeenCalledWith('candidate_id', ['cand1', 'cand2'])
    expect(result).toEqual({ cand1: 2, cand2: 1 })
  })

  it('throws instead of silently returning {} when Supabase reports an error', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(countPipelinesPerCandidate(['cand1'])).rejects.toEqual({ message: 'db down' })
  })
})

describe('listCandidatesForPipelinePicker', () => {
  it('reads id/name/role/company ordered by name, no client-side user_id filter', async () => {
    await listCandidatesForPipelinePicker()
    expect(fromMock).toHaveBeenCalledWith('candidates')
    expect(builder.select).toHaveBeenCalledWith('id, name, role, company')
    expect(builder.eq).not.toHaveBeenCalledWith('user_id', expect.anything())
    expect(builder.order).toHaveBeenCalledWith('name')
  })

  it('throws instead of silently returning [] when Supabase reports an error', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(listCandidatesForPipelinePicker()).rejects.toEqual({ message: 'db down' })
  })
})

// 2026-09-07, gap-analysis batch 8: replaces the old
// listCandidateJobLinks(candidates.job_id) count Jobs.jsx used to use for
// its own "Pipeline (N)" badge, which only ever reflected a candidate's
// ONE primary job, so it silently undercounted the moment a candidate got
// submitted to a second job from this board's own "add candidate to
// pipeline" picker (createPipelineLink, is_primary: false, above).
describe('listAllPipelineLinkCounts', () => {
  it('reads every job_id off candidate_job_links, primary and secondary alike', async () => {
    builder = makeBuilder({ data: [{ job_id: 'job1' }, { job_id: 'job1' }, { job_id: 'job2' }], error: null })
    fromMock.mockReturnValue(builder)
    const result = await listAllPipelineLinkCounts()
    expect(fromMock).toHaveBeenCalledWith('candidate_job_links')
    expect(builder.select).toHaveBeenCalledWith('job_id')
    expect(result).toEqual([{ job_id: 'job1' }, { job_id: 'job1' }, { job_id: 'job2' }])
  })

  it('returns an empty array rather than null when there are no rows', async () => {
    expect(await listAllPipelineLinkCounts()).toEqual([])
  })

  it('throws instead of silently returning [] when Supabase reports an error', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(listAllPipelineLinkCounts()).rejects.toEqual({ message: 'db down' })
  })
})
