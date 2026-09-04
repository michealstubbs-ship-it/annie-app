import { describe, it, expect } from 'vitest'
import { normalizeCompanyName, companiesMatch } from './companyMatch.js'

describe('normalizeCompanyName', () => {
  it('strips common legal suffixes', () => {
    expect(normalizeCompanyName('Acme Ltd')).toBe('acme')
    expect(normalizeCompanyName('Acme Limited')).toBe('acme')
    expect(normalizeCompanyName('Acme Inc')).toBe('acme')
    expect(normalizeCompanyName('Acme PLC')).toBe('acme')
  })

  it('handles empty input', () => {
    expect(normalizeCompanyName('')).toBe('')
    expect(normalizeCompanyName(null)).toBe('')
  })

  it('strips common UAE/GCC legal-entity suffixes', () => {
    expect(normalizeCompanyName('Acme Trading FZE')).toBe('acme trading')
    expect(normalizeCompanyName('Acme Trading DMCC')).toBe('acme trading')
    expect(normalizeCompanyName('Acme Holdings PJSC')).toBe('acme')
    expect(normalizeCompanyName('Acme Trading W.L.L.')).toBe('acme trading')
    expect(normalizeCompanyName('Acme Establishment')).toBe('acme')
  })
})

describe('companiesMatch', () => {
  it('matches exact names after normalization', () => {
    expect(companiesMatch('Acme Ltd', 'Acme Limited')).toBe(true)
  })

  it('matches via containment once both names are long enough', () => {
    expect(companiesMatch('Acme', 'Acme Group Holdings')).toBe(true)
  })

  it('does not match unrelated short names via accidental substring overlap', () => {
    expect(companiesMatch('AB', 'ABC Corp')).toBe(false)
  })

  it('does not match genuinely different companies', () => {
    expect(companiesMatch('Acme Ltd', 'Zenith Group')).toBe(false)
  })
})

// findWarmContacts was removed on 2026-09-04 — see companyMatch.js for why.
// The way-in ladder (src/lib/stream/wayIn.js) replaces it and has its own tests.
