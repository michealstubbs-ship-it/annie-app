import { describe, it, expect } from 'vitest'
import { buildLinkedinRoute, ROUTE_PROFILE, ROUTE_COMPANY_PEOPLE, ROUTE_SEARCH } from './linkedinRoute.js'

describe('buildLinkedinRoute — three tiers, honestly labelled', () => {
  it('tier 1: a real profile URL when one is known', () => {
    const route = buildLinkedinRoute({ company_name: 'Acme' }, { name: 'Dana Riaz', linkedin_url: 'https://www.linkedin.com/in/dana-riaz' })
    expect(route.tier).toBe(ROUTE_PROFILE)
    expect(route.approximate).toBe(false)
    expect(route.label).toContain('Dana Riaz')
  })

  it('takes the profile URL off the signal itself when the contact has none', () => {
    const route = buildLinkedinRoute({ company_name: 'Acme', contact_linkedin_url: 'https://linkedin.com/in/someone' })
    expect(route.tier).toBe(ROUTE_PROFILE)
  })

  it('tier 2: the company People page when a real company slug is known', () => {
    const route = buildLinkedinRoute({ company_name: 'Acme', company_linkedin_url: 'https://www.linkedin.com/company/acme-holdings' })
    expect(route.tier).toBe(ROUTE_COMPANY_PEOPLE)
    expect(route.url).toBe('https://www.linkedin.com/company/acme-holdings/people/')
    expect(route.approximate).toBe(false)
  })

  it('never GUESSES a company slug from the company name', () => {
    // LinkedIn assigns vanity slugs; deriving one from the name produces a
    // 404 that reads as a broken product.
    const route = buildLinkedinRoute({ company_name: 'ALAS Emirates Ready Mix' })
    expect(route.tier).toBe(ROUTE_SEARCH)
    expect(route.url).not.toContain('/company/')
  })

  it('tier 3: a keyword search, explicitly marked approximate', () => {
    const route = buildLinkedinRoute({ company_name: 'ALAS Emirates Ready Mix', likely_roles: ['Group CFO', 'Finance Director'] })
    expect(route.tier).toBe(ROUTE_SEARCH)
    expect(route.approximate).toBe(true)
    expect(decodeURIComponent(route.url)).toContain('ALAS Emirates Ready Mix')
    expect(decodeURIComponent(route.url)).toContain('Group CFO')
  })

  it('falls back to title_keywords when likely_roles is empty', () => {
    const route = buildLinkedinRoute({ company_name: 'Acme', title_keywords: ['chief financial officer'] })
    expect(decodeURIComponent(route.url)).toContain('chief financial officer')
  })

  it('still produces a company search when no role is known at all', () => {
    const route = buildLinkedinRoute({ company_name: 'Acme' })
    expect(route.tier).toBe(ROUTE_SEARCH)
    expect(route.label).toContain('Acme')
  })

  it('returns null only when there is genuinely nothing to search for', () => {
    expect(buildLinkedinRoute({ company_name: '' })).toBeNull()
  })

  it('does not treat a company URL as a personal profile', () => {
    const route = buildLinkedinRoute({ company_name: 'Acme' }, { linkedin_url: 'https://www.linkedin.com/company/acme' })
    expect(route.tier).not.toBe(ROUTE_PROFILE)
  })
})
