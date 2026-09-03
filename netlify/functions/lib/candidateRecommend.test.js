import { describe, it, expect } from 'vitest'
import {
  MAX_RECOMMENDATIONS,
  summarizeCandidateForPrompt,
  buildRecommendationSystemPrompt,
  buildRecommendationUserMessage,
  parseRecommendationsResponse,
} from './candidateRecommend.js'

describe('summarizeCandidateForPrompt', () => {
  it('produces a compact, prompt-safe view with no contact details', () => {
    const c = { id: 'c1', name: 'Jane Doe', role: 'CFO', company: 'Acme', industry: 'Finance', titles: ['CFO', 'VP Finance'], industries: ['Finance'], status: 'sourced', notice_period: '1 month', want_sal: 50000, want_sal_currency: 'AED', notes: 'x'.repeat(500), email: 'jane@example.com', phone: '+971', cv_path: 'user/1.pdf' }
    const summary = summarizeCandidateForPrompt(c)
    expect(summary).not.toHaveProperty('email')
    expect(summary).not.toHaveProperty('phone')
    expect(summary).not.toHaveProperty('cv_path')
    expect(summary.salary_expectation).toBe('50000 AED')
    expect(summary.notes.length).toBeLessThanOrEqual(300)
  })

  it('handles missing optional fields without throwing', () => {
    const summary = summarizeCandidateForPrompt({ id: 'c2', name: 'No Details' })
    expect(summary.titles).toEqual([])
    expect(summary.industries).toEqual([])
    expect(summary.salary_expectation).toBeNull()
    expect(summary.notes).toBe('')
  })
})

describe('buildRecommendationSystemPrompt', () => {
  it('instructs the model never to override the geographic pre-filter, and to return strict JSON', () => {
    const prompt = buildRecommendationSystemPrompt()
    expect(prompt).toMatch(/never second-guess/i)
    expect(prompt).toMatch(/STRICT JSON/)
    expect(prompt).toContain(String(MAX_RECOMMENDATIONS))
  })
})

describe('buildRecommendationUserMessage', () => {
  it('includes the job brief and every candidate summary as JSON', () => {
    const job = { title: 'Head of Commercial', industry: 'Retail', notes: 'GCC experience needed', fee_value: 40000, companies: { name: 'Meraas', location: 'Dubai, UAE' } }
    const candidates = [{ id: 'c1', name: 'Jane Doe' }]
    const parsed = JSON.parse(buildRecommendationUserMessage(job, candidates))
    expect(parsed.job).toEqual({ title: 'Head of Commercial', industry: 'Retail', company: 'Meraas', location: 'Dubai, UAE', fee_value: 40000, brief: 'GCC experience needed' })
    expect(parsed.candidates).toHaveLength(1)
    expect(parsed.candidates[0].id).toBe('c1')
  })
})

describe('parseRecommendationsResponse', () => {
  const candidatesById = new Map([
    ['c1', { id: 'c1', name: 'Jane Doe' }],
    ['c2', { id: 'c2', name: 'John Roe' }],
  ])

  it('resolves each recommended id to the real candidate object and sanitizes the reason', () => {
    const text = JSON.stringify([{ id: 'c1', reason: 'Strong fit <cite index="1">source</cite>' }])
    const out = parseRecommendationsResponse(text, candidatesById)
    expect(out).toEqual([{ candidate: candidatesById.get('c1'), reason: 'Strong fit source' }])
  })

  it('drops any id not present in the given candidate pool (never trust an invented id)', () => {
    const text = JSON.stringify([{ id: 'c1', reason: 'ok' }, { id: 'not_real', reason: 'ignored' }])
    const out = parseRecommendationsResponse(text, candidatesById)
    expect(out.map(r => r.candidate.id)).toEqual(['c1'])
  })

  it('drops a duplicate id, keeping only the first occurrence', () => {
    const text = JSON.stringify([{ id: 'c1', reason: 'first' }, { id: 'c1', reason: 'second' }])
    const out = parseRecommendationsResponse(text, candidatesById)
    expect(out).toHaveLength(1)
    expect(out[0].reason).toBe('first')
  })

  it('caps at MAX_RECOMMENDATIONS even if the model returns more', () => {
    const bigPool = new Map(Array.from({ length: 10 }, (_, i) => [`id${i}`, { id: `id${i}` }]))
    const bigText = JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ id: `id${i}`, reason: `r${i}` })))
    const out = parseRecommendationsResponse(bigText, bigPool)
    expect(out).toHaveLength(MAX_RECOMMENDATIONS)
  })

  it('returns an empty array for a genuinely empty AI response, and never throws on malformed JSON', () => {
    expect(parseRecommendationsResponse('[]', candidatesById)).toEqual([])
    expect(parseRecommendationsResponse('not json at all', candidatesById)).toEqual([])
  })
})
