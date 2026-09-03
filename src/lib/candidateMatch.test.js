import { describe, it, expect } from 'vitest'
import {
  matchCandidatesToSignal,
  prepareCandidatesForMatching,
  matchPreparedCandidatesToSignal,
  matchCandidatesToJob,
  matchPreparedCandidatesToJob,
  isGeographicallyEligible,
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

  it('caps results at 3, best matches first', () => {
    const signal = { title_keywords: ['Chief Financial Officer'], headline: '', company_industry: '' }
    const candidates = Array.from({ length: 8 }, (_, i) => ({ id: i, role: 'Chief Financial Officer', status: 'active' }))
    expect(matchCandidatesToSignal(signal, candidates)).toHaveLength(3)
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

// 2026-08-31: a candidate must overlap the signal's TITLE KEYWORDS, not just
// the headline prose or the industry. Regression cover for two real misses
// seen on the Aldermere CFO signal in the demo tenant.
describe('title-keyword gate', () => {
  it('does not match a COO to a CFO signal on the headline words "chief"/"officer"', () => {
    const signal = {
      title_keywords: ['CFO', 'Finance Director', 'Financial Controller'],
      headline: 'Aldermere Partners appoints a new Chief Financial Officer',
      company_industry: 'Financial Services',
    }
    const candidates = [{ id: 1, role: 'Chief Operating Officer', industry: 'Financial Services', status: 'interviewing' }]
    expect(matchCandidatesToSignal(signal, candidates)).toEqual([])
  })

  it('does not match on industry overlap alone', () => {
    const signal = { title_keywords: ['CFO'], headline: '', company_industry: 'Financial Services' }
    const candidates = [{ id: 1, role: 'Warehouse Operative', industry: 'Financial Services', status: 'active' }]
    expect(matchCandidatesToSignal(signal, candidates)).toEqual([])
  })

  it('still matches a genuine finance title', () => {
    const signal = {
      title_keywords: ['CFO', 'Finance Director', 'Financial Controller'],
      headline: 'Aldermere Partners appoints a new Chief Financial Officer',
      company_industry: 'Financial Services',
    }
    const candidates = [
      { id: 1, role: 'Group Financial Controller', industry: 'Energy & Utilities', status: 'sourced' },
      { id: 2, role: 'Finance Manager', industry: 'Financial Services', status: 'sourced' },
    ]
    expect(matchCandidatesToSignal(signal, candidates).map(c => c.id).sort()).toEqual([1, 2])
  })
})

// 2026-08-31: root-cause fix for "role fields holding sector names, and the
// matcher can't tell" — a real miss on the demo tenant (Susan Okoye, role
// "Partner, Financial Services", surfaced for a CFO signal purely because
// "financial" tokenized as if it were part of her title).
describe('comma-qualified role fields (sector words after a comma)', () => {
  it('does not match a "Partner, Financial Services" candidate to a CFO signal on the word "financial"', () => {
    const signal = {
      title_keywords: ['CFO', 'Finance Director', 'Financial Controller'],
      headline: 'Aldermere Partners appoints a new Chief Financial Officer',
      company_industry: 'Financial Services',
    }
    const candidates = [{ id: 1, role: 'Partner, Financial Services', industry: '', status: 'active' }]
    expect(matchCandidatesToSignal(signal, candidates)).toEqual([])
  })

  it('still matches a genuine title that happens to come before a comma-qualified sector', () => {
    const signal = { title_keywords: ['CFO'], headline: '', company_industry: '' }
    const candidates = [{ id: 1, role: 'CFO, Financial Services', industry: '', status: 'active' }]
    expect(matchCandidatesToSignal(signal, candidates).map(c => c.id)).toEqual([1])
  })

  it('folds the comma-qualifier into industry tokens, so it can still surface a candidate on real industry overlap', () => {
    const job = { title: 'Managing Director', notes: '', industry: 'Financial Services' }
    const candidates = [{ id: 1, role: 'Partner, Financial Services', industry: '', status: 'active' }]
    expect(matchCandidatesToJob(job, candidates).map(c => c.id)).toEqual([1])
  })

  it('a bare role with no comma is unaffected (existing behaviour)', () => {
    const signal = { title_keywords: ['Chief Financial Officer'], headline: '', company_industry: '' }
    const candidates = [{ id: 1, role: 'Chief Financial Officer', industry: '', status: 'active' }]
    expect(matchCandidatesToSignal(signal, candidates).map(c => c.id)).toEqual([1])
  })
})

// 2026-09-05, task #256: candidates.titles/industries (jsonb arrays) hold
// Annie's own CV-parse read on every OTHER title/industry a candidate's
// real experience could plausibly match — additive to the recruiter's own
// singular role/industry fields.
describe('titles/industries arrays (AI-inferred title equivalence, additive to role/industry)', () => {
  it('matches on an inferred title even though the recruiter-typed role field itself has no overlap', () => {
    const signal = { title_keywords: ['VP Marketing'], headline: '', company_industry: '' }
    const candidates = [{ id: 1, role: 'Head of Growth', titles: ['VP Marketing', 'Growth Lead'], industry: '', status: 'active' }]
    expect(matchCandidatesToSignal(signal, candidates).map(c => c.id)).toEqual([1])
  })

  it('matches on an inferred industry the same way', () => {
    const job = { title: '', notes: '', industry: 'Hospitality' }
    const candidates = [{ id: 1, role: 'Ops Manager', industry: 'Retail', industries: ['Hospitality', 'Facilities'], status: 'active' }]
    expect(matchCandidatesToJob(job, candidates).map(c => c.id)).toEqual([1])
  })

  it('a candidate with no titles/industries parsed still matches exactly as before (additive, not required)', () => {
    const signal = { title_keywords: ['CFO'], headline: '', company_industry: '' }
    const candidates = [{ id: 1, role: 'CFO', industry: '', status: 'active' }]
    expect(matchCandidatesToSignal(signal, candidates).map(c => c.id)).toEqual([1])
  })

  it('tolerates titles/industries being missing, null, or not an array, without throwing', () => {
    const signal = { title_keywords: ['CFO'], headline: '', company_industry: '' }
    expect(() => prepareCandidatesForMatching([
      { id: 1, role: 'CFO', status: 'active', titles: null, industries: null },
      { id: 2, role: 'CFO', status: 'active', titles: 'not-an-array' },
      { id: 3, role: 'CFO', status: 'active' },
    ])).not.toThrow()
  })
})

// 2026-09-05, Michael: "if any of the candidates are saudi nationals or
// emiratis, only recommend those candidates if those jobs are in Saudi or
// UAE if that makes sense" — the priority piece of the CV-scan rebuild.
describe('isGeographicallyEligible', () => {
  it('a Saudi national is eligible for a Saudi-located role', () => {
    expect(isGeographicallyEligible({ nationality: 'Saudi' }, 'Riyadh, Saudi Arabia')).toBe(true)
  })

  it('a Saudi national is NOT eligible for a role outside Saudi Arabia', () => {
    expect(isGeographicallyEligible({ nationality: 'Saudi Arabian' }, 'Dubai, UAE')).toBe(false)
  })

  it('an Emirati national is eligible for a UAE-located role', () => {
    expect(isGeographicallyEligible({ nationality: 'Emirati' }, 'Dubai, United Arab Emirates')).toBe(true)
  })

  it('an Emirati national is NOT eligible for a role outside the UAE', () => {
    expect(isGeographicallyEligible({ nationality: 'UAE National' }, 'Riyadh, Saudi Arabia')).toBe(false)
  })

  it('a candidate with no nationality on file is never gated', () => {
    expect(isGeographicallyEligible({ nationality: '' }, 'London, UK')).toBe(true)
    expect(isGeographicallyEligible({}, 'London, UK')).toBe(true)
  })

  it('a nationality Michael did not ask to gate is never restricted', () => {
    expect(isGeographicallyEligible({ nationality: 'British' }, 'anywhere at all')).toBe(true)
    expect(isGeographicallyEligible({ nationality: 'Egyptian' }, 'London, UK')).toBe(true)
  })
})

describe('geographic gating wired into real matching (signals and jobs)', () => {
  it('excludes a Saudi national from a live_job signal whose company is not in Saudi Arabia', () => {
    const signal = { title_keywords: ['CFO'], headline: '', company_industry: '', company_city: 'London', company_country: 'United Kingdom' }
    const candidates = [{ id: 1, role: 'CFO', nationality: 'Saudi', status: 'active' }]
    expect(matchCandidatesToSignal(signal, candidates)).toEqual([])
  })

  it('includes a Saudi national for a live_job signal whose company IS in Saudi Arabia', () => {
    const signal = { title_keywords: ['CFO'], headline: '', company_industry: '', company_city: 'Riyadh', company_country: 'Saudi Arabia' }
    const candidates = [{ id: 1, role: 'CFO', nationality: 'Saudi', status: 'active' }]
    expect(matchCandidatesToSignal(signal, candidates).map(c => c.id)).toEqual([1])
  })

  it('excludes an Emirati candidate from a customer-added job outside the UAE', () => {
    const job = { title: 'CFO', notes: '', industry: '', companies: { location: 'London, UK' } }
    const candidates = [{ id: 1, role: 'CFO', nationality: 'Emirati', status: 'active' }]
    expect(matchCandidatesToJob(job, candidates)).toEqual([])
  })

  it('includes an Emirati candidate for a customer-added job in the UAE', () => {
    const job = { title: 'CFO', notes: '', industry: '', companies: { location: 'Dubai, UAE' } }
    const candidates = [{ id: 1, role: 'CFO', nationality: 'Emirati', status: 'active' }]
    expect(matchCandidatesToJob(job, candidates).map(c => c.id)).toEqual([1])
  })

  it('a candidate with no nationality on file matches jobs/signals anywhere, as before', () => {
    const job = { title: 'CFO', notes: '', industry: '', companies: { location: 'London, UK' } }
    const candidates = [{ id: 1, role: 'CFO', status: 'active' }]
    expect(matchCandidatesToJob(job, candidates).map(c => c.id)).toEqual([1])
  })
})
