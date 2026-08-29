import { describe, it, expect } from 'vitest'
import {
  STAGES,
  searchCandidates,
  filterCandidatesByStage,
  sortCandidates,
  groupCandidatesByStage,
} from './candidatesView.js'

const CANDIDATES = [
  { id: '1', name: 'Zara Khan', role: 'CFO', company: 'Acme', location: 'Dubai', industry: 'Fintech', email: 'zara@acme.com', status: 'sourced', want_sal: 50000 },
  { id: '2', name: 'Amir Ali', role: 'CEO', company: 'Beta', location: 'Abu Dhabi', industry: 'Logistics', email: 'amir@beta.com', status: 'shortlisted', want_sal: 90000 },
  { id: '3', name: 'Beth Cole', role: 'COO', company: 'Acme', location: 'Dubai', industry: 'Fintech', email: 'beth@acme.com', status: 'sourced', want_sal: 70000 },
  { id: '4', name: 'Dana Fox', role: 'VP Sales', company: 'Gamma', location: 'Sharjah', industry: 'Retail', email: 'dana@gamma.com', status: 'placed', want_sal: null },
  { id: '5', name: 'Evan Grey', role: null, company: null, location: null, industry: null, email: null, status: 'withdrawn', want_sal: null },
]

describe('searchCandidates', () => {
  it('returns everything unchanged for a blank search', () => {
    expect(searchCandidates(CANDIDATES, '')).toEqual(CANDIDATES)
  })

  it('matches case-insensitively across name, role, company, location, industry, email', () => {
    expect(searchCandidates(CANDIDATES, 'zara').map(c => c.id)).toEqual(['1'])
    expect(searchCandidates(CANDIDATES, 'ACME').map(c => c.id)).toEqual(['1', '3'])
    expect(searchCandidates(CANDIDATES, 'ceo').map(c => c.id)).toEqual(['2'])
    expect(searchCandidates(CANDIDATES, 'dubai').map(c => c.id)).toEqual(['1', '3'])
    expect(searchCandidates(CANDIDATES, 'fintech').map(c => c.id)).toEqual(['1', '3'])
  })

  it('does not throw on a candidate with null fields', () => {
    expect(searchCandidates(CANDIDATES, 'evan').map(c => c.id)).toEqual(['5'])
  })
})

describe('filterCandidatesByStage', () => {
  it('returns everything for "all" or a falsy stage', () => {
    expect(filterCandidatesByStage(CANDIDATES, 'all')).toEqual(CANDIDATES)
    expect(filterCandidatesByStage(CANDIDATES, null)).toEqual(CANDIDATES)
  })

  it('narrows to exactly the matching stage', () => {
    expect(filterCandidatesByStage(CANDIDATES, 'sourced').map(c => c.id)).toEqual(['1', '3'])
    expect(filterCandidatesByStage(CANDIDATES, 'offer')).toEqual([])
  })
})

describe('sortCandidates', () => {
  it('leaves order untouched for "recent" or an unrecognized sortBy', () => {
    expect(sortCandidates(CANDIDATES, 'recent')).toEqual(CANDIDATES)
    expect(sortCandidates(CANDIDATES, undefined)).toEqual(CANDIDATES)
  })

  it('sorts by name alphabetically', () => {
    expect(sortCandidates(CANDIDATES, 'name').map(c => c.id)).toEqual(['2', '3', '4', '5', '1'])
  })

  it('sorts by desired salary, highest first, treating null as zero', () => {
    expect(sortCandidates(CANDIDATES, 'salary').map(c => c.id)).toEqual(['2', '3', '1', '4', '5'])
  })

  it('does not mutate the input array', () => {
    const copy = [...CANDIDATES]
    sortCandidates(CANDIDATES, 'name')
    expect(CANDIDATES).toEqual(copy)
  })
})

describe('groupCandidatesByStage', () => {
  it('groups into stage-ordered sections, omitting empty ones', () => {
    const groups = groupCandidatesByStage(CANDIDATES)
    expect(groups.map(g => g.stage)).toEqual(['sourced', 'shortlisted', 'placed', 'withdrawn'])
    expect(groups.find(g => g.stage === 'sourced').candidates.map(c => c.id)).toEqual(['1', '3'])
    expect(groups.find(g => g.stage === 'sourced').label).toBe('Sourced')
  })

  it('buckets an unrecognized status value into an "Other" group instead of dropping it', () => {
    const withWeird = [...CANDIDATES, { id: '6', name: 'Odd One', status: 'on_ice' }]
    const groups = groupCandidatesByStage(withWeird)
    const other = groups.find(g => g.stage === 'other')
    expect(other).toBeTruthy()
    expect(other.label).toBe('Other')
    expect(other.candidates.map(c => c.id)).toEqual(['6'])
  })

  it('returns an empty array for an empty candidate list', () => {
    expect(groupCandidatesByStage([])).toEqual([])
  })

  it('every known stage is represented in the label map', () => {
    for (const stage of STAGES) {
      expect(groupCandidatesByStage([{ id: 'x', status: stage }])[0].label).toBeTruthy()
    }
  })
})
