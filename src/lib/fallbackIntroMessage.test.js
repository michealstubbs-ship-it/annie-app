import { describe, it, expect } from 'vitest'
import { fallbackIntroMessage } from './fallbackIntroMessage.js'

describe('fallbackIntroMessage', () => {
  it('never includes the internal, recruiter-voiced analysis text (action.detail / why_it_matters)', () => {
    const action = {
      signalType: 'leadership_change',
      company: 'Aldermere',
      headline: 'Rosalind Attwood appointed CFO',
      detail: 'You have no relationship here yet, which makes this a clean first approach rather than a chase.',
      whoToApproach: 'Rosalind Attwood directly. Congratulate her, and offer help as she builds out the team beneath her.',
    }
    const msg = fallbackIntroMessage(action, { firmName: 'Test Firm', functions: ['Finance'], locations: ['UK'] })
    expect(msg).not.toContain('no relationship here yet')
    expect(msg).not.toContain('clean first approach')
    expect(msg).not.toContain(action.detail)
    expect(msg).not.toContain(action.whoToApproach)
  })

  it('congratulates on a leadership_change signal instead of a generic opener', () => {
    const action = { signalType: 'leadership_change', company: 'Aldermere', headline: 'x', detail: 'internal notes' }
    const msg = fallbackIntroMessage(action, {})
    expect(msg).toMatch(/^Congratulations on the new role at Aldermere\./)
  })

  it('references the public headline for a non-leadership signal, never the internal detail', () => {
    const action = { signalType: 'funding', company: 'Zenith', headline: 'Zenith raises $10M Series B', detail: 'internal reasoning about their weak finance bench' }
    const msg = fallbackIntroMessage(action, {})
    expect(msg).toContain('Zenith raises $10M Series B')
    expect(msg).not.toContain('internal reasoning')
  })

  it('falls back to a generic, still-safe opener when there is no headline at all', () => {
    const action = { signalType: 'expansion', detail: 'internal reasoning' }
    const msg = fallbackIntroMessage(action, {})
    expect(msg).toMatch(/hope you're doing well/i)
    expect(msg).not.toContain('internal reasoning')
  })

  it('uses the real firm name, functions, and locations when given, and safe defaults when not', () => {
    const action = { signalType: 'funding', headline: 'x' }
    const withProfile = fallbackIntroMessage(action, { firmName: 'Acme Search', functions: ['Legal', 'Finance'], locations: ['UAE', 'UK'] })
    expect(withProfile).toContain('Acme Search')
    expect(withProfile).toContain('Legal, Finance')
    expect(withProfile).toContain('UAE, UK')

    const withoutProfile = fallbackIntroMessage(action, {})
    expect(withoutProfile).toContain('I work for a recruitment firm')
    expect(withoutProfile).toContain('this space')
    expect(withoutProfile).toContain('the region')
  })

  it('always ends on a call-to-action, and never throws on a bare action object', () => {
    expect(() => fallbackIntroMessage({}, {})).not.toThrow()
    expect(fallbackIntroMessage({}, {})).toMatch(/open to a call/i)
  })
})
