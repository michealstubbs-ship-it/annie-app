import { describe, it, expect } from 'vitest'
import {
  listIndustries,
  searchCompanies,
  filterCompaniesByIndustry,
  sortCompanies,
  quotaDeadlineBadge,
} from './companiesView.js'

const COMPANIES = [
  { id: 'a', name: 'Zenith Group', industry: 'Fintech' },
  { id: 'b', name: 'Acme Trading', industry: 'Logistics' },
  { id: 'c', name: 'Beta Capital', industry: 'Fintech' },
  { id: 'd', name: 'Gamma Retail', industry: null },
]

const COUNTS = {
  a: { contacts: 2, openJobs: 0 },
  b: { contacts: 5, openJobs: 3 },
  c: { contacts: 5, openJobs: 1 },
  d: { contacts: 0, openJobs: 0 },
}

describe('listIndustries', () => {
  it('returns unique, alphabetically sorted, non-empty industries', () => {
    expect(listIndustries(COMPANIES)).toEqual(['Fintech', 'Logistics'])
  })

  it('returns an empty array when no company has an industry', () => {
    expect(listIndustries([{ id: 'x', name: 'X', industry: null }])).toEqual([])
  })
})

describe('searchCompanies', () => {
  it('returns everything unchanged for a blank search', () => {
    expect(searchCompanies(COMPANIES, '')).toEqual(COMPANIES)
  })

  it('matches case-insensitively on name only', () => {
    expect(searchCompanies(COMPANIES, 'acme').map(c => c.id)).toEqual(['b'])
    expect(searchCompanies(COMPANIES, 'ZENITH').map(c => c.id)).toEqual(['a'])
  })
})

describe('filterCompaniesByIndustry', () => {
  it('returns everything for "all" or a falsy value', () => {
    expect(filterCompaniesByIndustry(COMPANIES, 'all')).toEqual(COMPANIES)
    expect(filterCompaniesByIndustry(COMPANIES, null)).toEqual(COMPANIES)
  })

  it('narrows to exactly the matching industry', () => {
    expect(filterCompaniesByIndustry(COMPANIES, 'Fintech').map(c => c.id)).toEqual(['a', 'c'])
  })

  it('returns an empty array for an industry with no matches', () => {
    expect(filterCompaniesByIndustry(COMPANIES, 'Healthcare')).toEqual([])
  })
})

describe('sortCompanies', () => {
  it('defaults to alphabetical-by-name for an unrecognized sortBy', () => {
    expect(sortCompanies(COMPANIES, 'bogus', COUNTS).map(c => c.id)).toEqual(['b', 'c', 'd', 'a'])
    expect(sortCompanies(COMPANIES, undefined, COUNTS).map(c => c.id)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('sorts by most contacts, breaking ties alphabetically', () => {
    // b and c both have 5 contacts -> alphabetical tiebreak (Acme before Beta)
    expect(sortCompanies(COMPANIES, 'contacts', COUNTS).map(c => c.id)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('sorts by most open jobs, breaking ties alphabetically', () => {
    // a (Zenith Group) and d (Gamma Retail) both have 0 open jobs -> alphabetical tiebreak
    expect(sortCompanies(COMPANIES, 'jobs', COUNTS).map(c => c.id)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('treats a company missing from the counts map as zero, not an error', () => {
    expect(sortCompanies(COMPANIES, 'contacts', {}).map(c => c.id)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('does not mutate the input array', () => {
    const copy = [...COMPANIES]
    sortCompanies(COMPANIES, 'contacts', COUNTS)
    expect(COMPANIES).toEqual(copy)
  })
})

describe('quotaDeadlineBadge', () => {
  const today = new Date('2026-09-06T12:00:00')

  it('returns null when no deadline is set', () => {
    expect(quotaDeadlineBadge(null, today)).toBeNull()
  })

  it('flags a passed deadline as critical', () => {
    const badge = quotaDeadlineBadge('2026-09-01', today)
    expect(badge.level).toBe('critical')
    expect(badge.label).toContain('passed')
  })

  it('flags a deadline within 60 days as critical', () => {
    expect(quotaDeadlineBadge('2026-10-01', today).level).toBe('critical')
  })

  it('flags a deadline within 180 days as watch', () => {
    expect(quotaDeadlineBadge('2027-01-01', today).level).toBe('watch')
  })

  it('treats a distant deadline as ok', () => {
    expect(quotaDeadlineBadge('2028-01-01', today).level).toBe('ok')
  })
})
