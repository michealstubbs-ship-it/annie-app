import { describe, it, expect } from 'vitest'
import {
  matchCandidatesToSignal,
  prepareCandidatesForMatching,
  matchPreparedCandidatesToSignal,
  matchCandidatesToJob,
  matchPreparedCandidatesToJob,
} from './candidateMatch.js'

describe('matchCandidatesToSignal', () => {
  it('matches a candidate whose role overlaps the signal\'s title keywords', () => {
    const signal = { title_keywords: ['CFO', 'Finance Director'], headline: 'Raises $10M', company_industry: 'Fintech' }
    const candidates = [{ id: 1, role: 'CFO', industry: 'Fintech', status: 'active' }]
    const matches = matchCandidatesToSignal(signal, candidates)
    expect(matches).toHaveLength(1)
    expect(matches[0].id).toBe(1)
  })

  it('excludes candidates in closed statuses (placed/rejected/withdrawn)', () => {
    const signal = { title_keywords: ['CFO'], headline: '', company_industry: '' }
    const candidates = [{ id: 1, role: 'CFO', status: 'placed' }]
    expect(matchCandidatesToSignal(signal, candidates)).toEqual([])
  })

  it('returns nothing when there is no meaningful overlap', () => {
    const signal = { title_keywords: ['Head of Legal'], headline: '', company_industry: '' }
    const candidates = [{ id: 1, role: 'Warehouse Operative', status: 'active' }]
    expect(matchCandidatesToSignal(signal, candidates)).toEqual([])
  })

  it('caps results at 5, best matches first', () => {
    const signal = { title_keywords: ['Chief Financial Officer'], headline: '', company_industry: '' }
    const candidates = Array.from({ length: 8 }, (_, i) => ({ id: i, role: 'Chief Financial Officer', status: 'active' }))
    expect(matchCandidatesToSignal(signal, candidates)).toHaveLength(5)
  })

  it('handles missing signal or empty candidate list without throwing', () => {
    expect(matchCandidatesToSignal(null, [{ id: 1 }])).toEqual([])
    expect(matchCandidatesToSignal({ title_keywords: [] }, [])).toEqual([])
  })
})

// 2026-08-29 audit fix: the fast path for matching one candidate pool
// against many signals in the same pass (Today's Actions), without
// re-tokenizing the same candidates on every call — see candidateMatch.js's
// own header for the real-world hang this fixes.
describe('prepareCandidatesForMatching + matchPreparedCandidatesToSignal', () => {
  it('produces identical results to matchCandidatesToSignal for the same inputs', () => {
    const signal = { title_keywords: ['CFO', 'Finance Director'], headline: 'Raises $10M', company_industry: 'Fintech' }
    const candidates = [
      { id: 1, role: 'CFO', industry: 'Fintech', status: 'active' },
      { id: 2, role: 'Warehouse Operative', status: 'active' },
      { id: 3, role: 'Finance Director', industry: 'Fintech', status: 'placed' }, // excluded, closed status
    ]
    const prepared = prepareCandidatesForMatching(candidates)
    expect(matchPreparedCandidatesToSignal(signal, prepared)).toEqual(matchCandidatesToSignal(signal, candidates))
  })

  it('lets one prepared pool be matched against several different signals correctly', () => {
    const candidates = [
      { id: 1, role: 'CFO', industry: 'Fintech', status: 'active' },
      { id: 2, role: 'Head of Legal', industry: 'Fintech', status: 'active' },
    ]
    const prepared = prepareCandidatesForMatching(candidates)

    const cfoSignal = { title_keywords: ['CFO'], headline: '', company_industry: '' }
    const legalSignal = { title_keywords: ['Head of Legal'], headline: '', company_industry: '' }

    expect(matchPreparedCandidatesToSignal(cfoSignal, prepared).map(c => c.id)).toEqual([1])
    expect(matchPreparedCandidatesToSignal(legalSignal, prepared).map(c => c.id)).toEqual([2])
  })

  it('excludes closed-status candidates at prepare time, same as matchCandidatesToSignal', () => {
    const candidates = [{ id: 1, role: 'CFO', status: 'withdrawn' }]
    const prepared = prepareCandidatesForMatching(candidates)
    expect(prepared).toEqual([])
  })

  it('handles a missing/empty prepared pool without throwing', () => {
    expect(matchPreparedCandidatesToSignal({ title_keywords: ['CFO'] }, [])).toEqual([])
    expect(matchPreparedCandidatesToSignal({ title_keywords: ['CFO'] }, null)).toEqual([])
    expect(prepareCandidatesForMatching(null)).toEqual([])
  })
})

// 2026-08-29: candidate-to-JOB matching (Jobs & Mandates' "Suggested
// candidates" panel) — same scoring engine as signal-matching above, pointed
// at title/notes/industry instead of title_keywords/headline/company_industry.
describe('matchCandidatesToJob', () => {
  it('matches a candidate whose industry overlaps the job industry, even with no title overlap', () => {
    const job = { title: 'Chief Financial Officer', notes: 'Series B fintech scaling fast', industry: 'Fintech' }
    const candidates = [{ id: 1, role: 'CFO', industry: 'Fintech', status: 'active' }]
    expect(matchCandidatesToJob(job, candidates).map(c => c.id)).toEqual([1])
  })

  it('matches on real token overlap between job title/notes and candidate role', () => {
    const job = { title: 'Finance Director', notes: 'Looking for a finance director with fintech experience', industry: 'Fintech' }
    const candidates = [
      { id: 1, role: 'Finance Director', industry: 'Fintech', status: 'active' },
      { id: 2, role: 'Warehouse Operative', industry: 'Logistics', status: 'active' },
    ]
    expect(matchCandidatesToJob(job, candidates).map(c => c.id)).toEqual([1])
  })

  it('excludes candidates in closed statuses (placed/rejected/withdrawn)', () => {
    const job = { title: 'Finance Director', notes: '', industry: '' }
    const candidates = [{ id: 1, role: 'Finance Director', status: 'placed' }]
    expect(matchCandidatesToJob(job, candidates)).toEqual([])
  })

  it('caps results at 5, best matches first', () => {
    const job = { title: 'Finance Director', notes: '', industry: '' }
    const candidates = Array.from({ length: 8 }, (_, i) => ({ id: i, role: 'Finance Director', status: 'active' }))
    expect(matchCandidatesToJob(job, candidates)).toHaveLength(5)
  })

  it('handles missing job or empty candidate list without throwing', () => {
    expect(matchCandidatesToJob(null, [{ id: 1 }])).toEqual([])
    expect(matchCandidatesToJob({ title: 'CFO' }, [])).toEqual([])
  })
})

describe('matchPreparedCandidatesToJob', () => {
  it('produces identical results to matchCandidatesToJob for the same inputs', () => {
    const job = { title: 'Finance Director', notes: 'fintech background preferred', industry: 'Fintech' }
    const candidates = [
      { id: 1, role: 'Finance Director', industry: 'Fintech', status: 'active' },
      { id: 2, role: 'Warehouse Operative', status: 'active' },
      { id: 3, role: 'Finance Director', industry: 'Fintech', status: 'rejected' }, // excluded, closed status
    ]
    const prepared = prepareCandidatesForMatching(candidates)
    expect(matchPreparedCandidatesToJob(job, prepared)).toEqual(matchCandidatesToJob(job, candidates))
  })

  it('lets one prepared pool be matched against several different jobs correctly', () => {
    const candidates = [
      { id: 1, role: 'Finance Director', industry: 'Fintech', status: 'active' },
      { id: 2, role: 'Head of Legal', industry: 'Fintech', status: 'active' },
    ]
    const prepared = prepareCandidatesForMatching(candidates)

    const financeJob = { title: 'Finance Director', notes: '', industry: '' }
    const legalJob = { title: 'Head of Legal', notes: '', industry: '' }

    expect(matchPreparedCandidatesToJob(financeJob, prepared).map(c => c.id)).toEqual([1])
    expect(matchPreparedCandidatesToJob(legalJob, prepared).map(c => c.id)).toEqual([2])
  })

  it('handles a missing/empty prepared pool without throwing', () => {
    expect(matchPreparedCandidatesToJob({ title: 'CFO' }, [])).toEqual([])
    expect(matchPreparedCandidatesToJob({ title: 'CFO' }, null)).toEqual([])
  })
})
