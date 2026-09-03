import { describe, it, expect } from 'vitest'
import { parseBooleanQuery, searchCandidatesBoolean } from './booleanSearch.js'

const CANDIDATES = [
  { id: '1', name: 'Zara Khan', role: 'Python Developer', notes: 'Strong Django background' },
  { id: '2', name: 'Amir Ali', role: 'Java Developer', notes: 'Enterprise contractor' },
  { id: '3', name: 'Beth Cole', role: 'Python Developer', notes: 'Flask and Django, permanent only' },
  { id: '4', name: 'Dana Fox', role: 'VP Sales', notes: '' },
  { id: '5', name: 'Evan Grey', role: 'Full Stack Engineer', notes: 'python and java both' },
]

describe('searchCandidatesBoolean', () => {
  it('returns everything unchanged for a blank query', () => {
    expect(searchCandidatesBoolean(CANDIDATES, '')).toEqual(CANDIDATES)
    expect(searchCandidatesBoolean(CANDIDATES, '   ')).toEqual(CANDIDATES)
  })

  it('implicit AND between two bare words', () => {
    // "python developer" — every python-role candidate happens to also
    // have "developer" in their role, so this narrows to id 1 and 3 only
    // (5 has python in notes but role is "Full Stack Engineer", no "developer").
    expect(searchCandidatesBoolean(CANDIDATES, 'python developer').map(c => c.id)).toEqual(['1', '3'])
  })

  it('explicit OR', () => {
    expect(searchCandidatesBoolean(CANDIDATES, 'sales OR java').map(c => c.id).sort()).toEqual(['2', '4', '5'])
  })

  it('explicit AND with NOT', () => {
    expect(searchCandidatesBoolean(CANDIDATES, 'python AND NOT contractor').map(c => c.id).sort()).toEqual(['1', '3', '5'])
  })

  it('parentheses group an OR before an AND', () => {
    expect(searchCandidatesBoolean(CANDIDATES, 'python AND (flask OR django)').map(c => c.id).sort()).toEqual(['1', '3'])
  })

  it('quoted phrase matches the exact phrase only', () => {
    expect(searchCandidatesBoolean(CANDIDATES, '"full stack"').map(c => c.id)).toEqual(['5'])
    expect(searchCandidatesBoolean(CANDIDATES, '"stack full"')).toEqual([])
  })

  it('is case-insensitive for both operators and terms', () => {
    expect(searchCandidatesBoolean(CANDIDATES, 'PYTHON and not CONTRACTOR').map(c => c.id).sort()).toEqual(['1', '3', '5'])
  })

  it('does not throw on a malformed query (unbalanced parens, trailing operator)', () => {
    expect(() => searchCandidatesBoolean(CANDIDATES, 'python AND (django OR')).not.toThrow()
    expect(() => searchCandidatesBoolean(CANDIDATES, 'python AND')).not.toThrow()
    expect(() => searchCandidatesBoolean(CANDIDATES, ')))((')).not.toThrow()
  })

  it('falls back to the titles/industries arrays when the literal role field misses', () => {
    const withInferred = [{ id: '9', name: 'Cam Reed', role: 'Consultant', notes: '', titles: ['Python Developer'], industries: [] }]
    expect(searchCandidatesBoolean(withInferred, 'python').map(c => c.id)).toEqual(['9'])
  })
})

describe('parseBooleanQuery', () => {
  it('returns null for an empty query', () => {
    expect(parseBooleanQuery('')).toBeNull()
  })

  it('never throws regardless of input', () => {
    expect(() => parseBooleanQuery('(((')).not.toThrow()
    expect(() => parseBooleanQuery('AND OR NOT')).not.toThrow()
    expect(() => parseBooleanQuery('"unterminated')).not.toThrow()
  })
})
