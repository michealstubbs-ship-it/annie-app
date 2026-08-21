import { describe, it, expect } from 'vitest'
import { matchCandidatesToSignal } from './candidateMatch.js'

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
