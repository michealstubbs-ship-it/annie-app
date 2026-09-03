import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }))
vi.mock('./supabase', () => ({ supabase: { auth: { getSession: getSessionMock } } }))

import { recommendCandidatesForJob } from './candidateRecommendClient.js'

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('recommendCandidatesForJob', () => {
  it('throws without calling fetch when there is no signed-in session', async () => {
    getSessionMock.mockResolvedValue({ data: { session: null } })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(recommendCandidatesForJob('job_1')).rejects.toThrow('You need to be signed in for that.')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('posts the job id with a bearer token and returns the parsed JSON', async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'tok_abc' } } })
    const fetchSpy = vi.fn().mockResolvedValue({ json: async () => ({ ok: true, recommendations: [{ candidate: { id: 'c1', name: 'Jane Doe' }, reason: 'Strong fit' }] }) })
    vi.stubGlobal('fetch', fetchSpy)

    const result = await recommendCandidatesForJob('job_1')

    expect(fetchSpy).toHaveBeenCalledWith('/.netlify/functions/recommend-candidates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok_abc' },
      body: JSON.stringify({ job_id: 'job_1' }),
    })
    expect(result.ok).toBe(true)
    expect(result.recommendations).toHaveLength(1)
  })

  it('returns a friendly ok:false rather than throwing when the response body is malformed', async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'tok_abc' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => { throw new Error('not json') } }))
    const result = await recommendCandidatesForJob('job_1')
    expect(result.ok).toBe(false)
  })
})
