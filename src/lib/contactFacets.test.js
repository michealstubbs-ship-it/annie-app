// Tests for the facets the whole network-first product ranks on. If these are
// wrong, the backlog ranks the wrong people to the top and every downstream
// piece — the feed, the scan's warmth line, the marketing claim — inherits it.
import { describe, it, expect } from 'vitest'
import {
  deriveSeniorityBand,
  deriveFunctionArea,
  deriveRelationshipTier,
  deriveContactFacets,
  SENIORITY_BANDS,
  isLikelyCompetitor,
} from './contactFacets'

describe('deriveSeniorityBand', () => {
  it('reads the obvious C-suite titles', () => {
    expect(deriveSeniorityBand('Chief Strategy Officer')).toBe('c_suite')
    expect(deriveSeniorityBand('CEO')).toBe('c_suite')
    expect(deriveSeniorityBand('Group CFO')).toBe('c_suite')
    expect(deriveSeniorityBand('Managing Partner')).toBe('c_suite')
    expect(deriveSeniorityBand('Founder')).toBe('c_suite')
    expect(deriveSeniorityBand('Managing Director')).toBe('c_suite')
  })

  // The trap this classifier exists to avoid. 'president' is a C-suite keyword
  // in the shared vocabulary and it sits inside 'vice president' as a whole
  // bounded word, so a naive highest-band-first check promotes every VP to the
  // C-suite. On the measured account VP-level titles outnumber real presidents,
  // so this single bug would have mis-ranked a large slice of the backlog.
  it('does not promote a vice president to the C-suite', () => {
    expect(deriveSeniorityBand('Vice President - Head of Strategy')).toBe('director_vp')
    expect(deriveSeniorityBand('Vice President, Corporate Development')).toBe('director_vp')
    expect(deriveSeniorityBand('Vice-President Finance')).toBe('director_vp')
  })

  // The inverse trap, caught while writing these tests rather than in
  // production: keywordMatches is correctly boundary-aware, so 'vp' does NOT
  // match inside "SVP" (the 's' is a word character). Without an explicit
  // phrase check an SVP scores no marker at all and sinks to 'below'.
  it('recognises SVP and EVP as Director/VP, not as unranked', () => {
    expect(deriveSeniorityBand('SVP Corporate Development')).toBe('director_vp')
    expect(deriveSeniorityBand('EVP, Operations')).toBe('director_vp')
  })

  it('reads Director, VP and Head of as one band', () => {
    expect(deriveSeniorityBand('Director of Product Strategy')).toBe('director_vp')
    expect(deriveSeniorityBand('Head of AI & Analytics')).toBe('director_vp')
    expect(deriveSeniorityBand('VP Engineering')).toBe('director_vp')
  })

  it('reads manager-level titles', () => {
    expect(deriveSeniorityBand('Senior Manager, Strategy')).toBe('manager_plus')
    expect(deriveSeniorityBand('Engineering Lead')).toBe('manager_plus')
  })

  // 'md' is a C-suite keyword in the filter vocabulary and matches a
  // physician's post-nominal exactly as well as a managing director. A filter
  // that over-matches shows one spurious row; a classifier that over-matches
  // puts a doctor above a real MD on the call list.
  it('does not read a physician post-nominal as managing director', () => {
    expect(deriveSeniorityBand('Sarah Khan, MD')).not.toBe('c_suite')
    // ...while the title actually written out still lands correctly.
    expect(deriveSeniorityBand('Managing Director, Investments')).toBe('c_suite')
  })

  // Both titles below are real, common corporate roles taken from the measured
  // network. 'partner' as a bare keyword promoted them to the top of the call
  // list, above real equity partners and sovereign-fund C-suite.
  it('does not read a Business Partner as a partner', () => {
    expect(deriveSeniorityBand('Finance Business Partner')).not.toBe('c_suite')
    expect(deriveSeniorityBand('Human Resources Business Partner')).not.toBe('c_suite')
    // Consulting grade below partner.
    expect(deriveSeniorityBand('Associate Partner / Principal | Head of Growth')).toBe('director_vp')
    // ...while a real partner is untouched.
    expect(deriveSeniorityBand('Founding Partner')).toBe('c_suite')
    expect(deriveSeniorityBand('Partner')).toBe('c_suite')
  })

  // Found by running the ranker over a real network rather than by unit test:
  // "Assistant Manager - CEO Office" came out FIRST on the call list, because
  // 'ceo' matches inside "CEO Office" as a whole bounded word. An office is a
  // department, not the person who runs it.
  it('does not read a department name as the role', () => {
    expect(deriveSeniorityBand('Assistant Manager - CEO Office')).toBe('manager_plus')
    expect(deriveSeniorityBand('Strategy Manager - CEO Office')).toBe('manager_plus')
    expect(deriveSeniorityBand('Transformation Portfolio Lead - Wholesale Chief Operating Office')).not.toBe('c_suite')
    // ...while a title that is senior on its own terms survives the strip.
    expect(deriveSeniorityBand('Chief Executive Officer')).toBe('c_suite')
  })

  // Michael's own call on his own market, 2026-09-05: a Chief of Staff sits in
  // the C-suite office and opens doors, but does not hold the hiring budget, so
  // they are an influencer rather than a buyer. Roughly 25 of them in the
  // measured network, so this decides the whole top of the call list.
  it('places Chief of Staff in the Director band, not the C-suite', () => {
    expect(deriveSeniorityBand('Chief of Staff')).toBe('director_vp')
    expect(deriveSeniorityBand('Group Chief of Staff')).toBe('director_vp')
    // The reporting line must not re-promote them — a stray 'ceo' or 'chairman'
    // in "Chief of Staff to Chairman & CEO" names their boss, not their job.
    expect(deriveSeniorityBand('Chief of Staff to Chairman & CEO')).toBe('director_vp')
    expect(deriveSeniorityBand("Chief of Staff - CEO's Office")).toBe('director_vp')
    // ...and stripping the phrase instead would have sunk them to 'below',
    // which is wrong in the other direction.
    expect(deriveSeniorityBand('Chief of Staff')).not.toBe('below')
    // Real C-suite is untouched.
    expect(deriveSeniorityBand('Chief Strategy Officer')).toBe('c_suite')
  })

  it('returns below for an unmarked title and null for nothing', () => {
    expect(deriveSeniorityBand('Analyst')).toBe('below')
    expect(deriveSeniorityBand('')).toBeNull()
    expect(deriveSeniorityBand(null)).toBeNull()
    expect(deriveSeniorityBand(undefined)).toBeNull()
  })

  it('only ever returns a known band key', () => {
    const valid = new Set([...SENIORITY_BANDS.map(b => b.key), 'below'])
    const titles = ['Chief Executive', 'Partner', 'Head of Tax', 'Intern', 'Consultant', 'Snr Associate']
    for (const t of titles) expect(valid.has(deriveSeniorityBand(t))).toBe(true)
  })
})

describe('deriveFunctionArea', () => {
  it('places the functions this network is actually built on', () => {
    expect(deriveFunctionArea('Chief Strategy Officer')).toBe('Strategy & Corporate Development')
    expect(deriveFunctionArea('Head of Corporate Development')).toBe('Strategy & Corporate Development')
    expect(deriveFunctionArea('Group CFO')).toBe('Finance & Accounting')
    expect(deriveFunctionArea('Head of AI & Analytics')).toBe('Technology, Data & Engineering')
  })

  it('returns a parent function, never a narrowed sub-label', () => {
    const out = deriveFunctionArea('Head of Strategy')
    expect(out).toBeTruthy()
    expect(out).not.toContain(' > ')
  })

  it('returns null when a title carries no function signal', () => {
    expect(deriveFunctionArea('')).toBeNull()
    expect(deriveFunctionArea('Zzzz Qqqq')).toBeNull()
  })

  // Titles genuinely belong to more than one function; the point is that the
  // tie-break is deterministic, not that one answer is objectively right.
  it('resolves an ambiguous title the same way every time', () => {
    const a = deriveFunctionArea('Head of Regulatory Affairs')
    const b = deriveFunctionArea('Head of Regulatory Affairs')
    expect(a).toBe(b)
    expect(a).toBeTruthy()
  })
})

describe('deriveRelationshipTier', () => {
  it('is a connection when there is no channel of your own', () => {
    expect(deriveRelationshipTier({})).toBe('connection')
    expect(deriveRelationshipTier({ email: '', phone: '   ' })).toBe('connection')
  })

  it('is a contact once a real channel exists', () => {
    expect(deriveRelationshipTier({ email: 'a@visa.com' })).toBe('contact')
    expect(deriveRelationshipTier({ phone: '+971 50 000 0000' })).toBe('contact')
  })

  // Nothing may promote to client by inference. Only the mailbox backfill can
  // prove a two-way exchange, and it passes that proof in explicitly.
  it('only reaches client on proven two-way history', () => {
    expect(deriveRelationshipTier({ email: 'a@visa.com', hasTwoWayHistory: true })).toBe('client')
    expect(deriveRelationshipTier({ email: 'a@visa.com', hasTwoWayHistory: false })).toBe('contact')
    // An email address alone is not evidence of a relationship.
    expect(deriveRelationshipTier({ email: 'a@visa.com' })).not.toBe('client')
  })
})

// Both example titles are real rows from the measured network. They classify
// as C-suite and would otherwise rank at the very top of the customer's own
// call list — the first people a recruiter is told to call would be rival
// recruiters.
describe('isLikelyCompetitor', () => {
  it('flags other search professionals in the network', () => {
    expect(isLikelyCompetitor('Managing Director | Finance & Accountancy Recruiter | Headhunter')).toBe(true)
    expect(isLikelyCompetitor('Managing Director - AI & Technology Recruitment & Executive Search')).toBe(true)
    expect(isLikelyCompetitor('Head of Talent Acquisition')).toBe(true)
  })

  it('does not flag ordinary prospects', () => {
    expect(isLikelyCompetitor('Chief Strategy Officer', 'ADQ')).toBe(false)
    expect(isLikelyCompetitor('Head of AI & Analytics', 'ADNOC Distribution')).toBe(false)
    expect(isLikelyCompetitor('')).toBe(false)
  })

  // An in-house TA lead is a competitor for a mandate but still a real
  // relationship, so the flag informs ranking rather than deleting the row.
  it('is a flag, not a filter — seniority is still derived', () => {
    expect(deriveSeniorityBand('Managing Director - Executive Search')).toBe('c_suite')
  })
})

describe('deriveContactFacets', () => {
  it('returns every facet in the shape the columns expect', () => {
    expect(deriveContactFacets({
      title: 'Vice President - Head of Strategy',
      company: 'DP World',
      email: '',
    })).toEqual({
      seniority_band: 'director_vp',
      function_area: 'Strategy & Corporate Development',
      relationship_tier: 'connection',
      is_competitor: false,
    })
  })

  it('survives an empty row without throwing', () => {
    expect(() => deriveContactFacets({})).not.toThrow()
    expect(() => deriveContactFacets()).not.toThrow()
  })
})
