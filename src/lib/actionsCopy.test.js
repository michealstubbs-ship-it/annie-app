import { describe, it, expect } from 'vitest'
import { buildCandidatePitchPrompt, buildEnrichmentPrompt, fallbackHeadline, fallbackDetail } from './actionsCopy.js'

describe('buildEnrichmentPrompt', () => {
  it('gives every item a positional id and tells the model to echo it back', () => {
    const items = [
      { category: 'dormant', signals: {}, contact: { name: 'A', company: 'Acme', title: 'CFO' } },
      { category: 'relationship', signals: {}, signal: { company_name: 'Zenith', headline: 'Raises Series B' }, contact: { name: 'B' } },
    ]
    const prompt = buildEnrichmentPrompt(items, null, null)
    expect(prompt).toContain('"id":0')
    expect(prompt).toContain('"id":1')
    expect(prompt).toMatch(/echo that same id back/i)
  })

  it('tells the model relationship items still need full substance, not just a softer tone', () => {
    const prompt = buildEnrichmentPrompt([{ category: 'relationship', signals: {}, signal: { company_name: 'Zenith', headline: 'x' }, contact: {} }], null, null)
    expect(prompt).toMatch(/never with less substance/i)
  })
})

describe('fallbackHeadline / fallbackDetail', () => {
  it('builds honest, grounded copy for a relationship item with no AI entry, distinct from the couldn\'t-load-details failure copy', () => {
    const item = { category: 'relationship', signal: { company_name: 'Zenith', headline: 'Appoints new CFO', why_it_matters: 'A new CFO often resets vendor relationships.' } }
    expect(fallbackHeadline(item)).toBe('Appoints new CFO')
    expect(fallbackDetail(item)).toBe('A new CFO often resets vendor relationships.')
  })

  it('falls back to a generic relationship line when the signal has no why_it_matters', () => {
    const item = { category: 'relationship', signal: { company_name: 'Zenith' } }
    expect(fallbackDetail(item)).toContain('Zenith')
  })

  it('builds a dormant-contact headline from the real contact name', () => {
    const item = { category: 'dormant', contact: { name: 'Hassan Al Rayes' }, signals: { 'Last contact': '90 days ago' } }
    expect(fallbackHeadline(item)).toBe('Re-engage Hassan Al Rayes')
    expect(fallbackDetail(item)).toBe('90 days ago')
  })

  it('never returns empty for an unrecognised category', () => {
    const item = { category: 'unknown' }
    expect(fallbackHeadline(item)).toBe('Follow up')
    expect(fallbackDetail(item).length).toBeGreaterThan(0)
  })
})

describe('buildCandidatePitchPrompt', () => {
  it('includes every pairing given, same order, with only the real grounding fields', () => {
    const targets = [
      { signal: { headline: 'Raises Series B', industry: 'Fintech' }, candidate: { role: 'CFO', company: 'Acme Ltd', industry: 'Fintech', status: 'warm', notes: 'Led a prior Series C raise' } },
      { signal: { headline: 'Appoints new CEO', industry: 'Logistics' }, candidate: { role: 'COO', company: 'Zenith Group', industry: 'Logistics', status: 'new', notes: '' } },
    ]
    const prompt = buildCandidatePitchPrompt(targets)
    expect(prompt).toContain('Raises Series B')
    expect(prompt).toContain('Led a prior Series C raise')
    expect(prompt).toContain('Appoints new CEO')
    expect(prompt).toContain('Zenith Group')
  })

  it('explicitly instructs the model not to invent facts beyond what is given', () => {
    const prompt = buildCandidatePitchPrompt([{ signal: { headline: 'x', industry: 'y' }, candidate: { role: 'r', company: 'c', industry: 'i', status: 's', notes: '' } }])
    expect(prompt).toMatch(/do not invent/i)
  })

  it('asks for a plain JSON array of strings, same length as the input', () => {
    const prompt = buildCandidatePitchPrompt([
      { signal: { headline: 'a', industry: 'b' }, candidate: { role: 'r1', company: 'c1', industry: 'i1', status: 's1', notes: '' } },
      { signal: { headline: 'c', industry: 'd' }, candidate: { role: 'r2', company: 'c2', industry: 'i2', status: 's2', notes: '' } },
    ])
    expect(prompt).toMatch(/JSON array/i)
    expect(prompt).toMatch(/same order and length/i)
  })

  it('falls back to an empty string for a candidate with no notes on file, rather than throwing', () => {
    const prompt = buildCandidatePitchPrompt([{ signal: { headline: 'x', industry: 'y' }, candidate: { role: 'r', company: 'c', industry: 'i', status: 's' } }])
    expect(prompt).toContain('"notes":""')
  })
})
