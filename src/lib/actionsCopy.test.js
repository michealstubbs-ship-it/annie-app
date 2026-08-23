import { describe, it, expect } from 'vitest'
import { buildCandidatePitchPrompt } from './actionsCopy.js'

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
