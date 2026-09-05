import { describe, it, expect } from 'vitest'
import { cardEmail } from './cardEmail'

const item = (signal = {}) => ({ signal: { company_name: 'NEOM', ...signal } })
const nader = { id: 'c1', name: 'Nader Ashoor', company: 'NEOM' }

describe('cardEmail', () => {
  it('shows the real address when the customer already has one', () => {
    const out = cardEmail({ item: item(), person: { ...nader, email: 'n.ashoor@neom.com' }, domain: 'neom.com' })
    expect(out).toMatchObject({ email: 'n.ashoor@neom.com', status: 'known', canVerify: false })
  })

  it('prefers a real address over a guess it could have built', () => {
    const out = cardEmail({ item: item(), person: { ...nader, email: 'n.ashoor@neom.com' }, domain: 'neom.com', pattern: { pattern: 'first.last' } })
    expect(out.email).toBe('n.ashoor@neom.com')
  })

  it('shows an Apollo-verified address as verified', () => {
    const out = cardEmail({ item: item({ contact_name: 'Nader Ashoor', contact_email: 'nader@neom.com', contact_verified: true }), domain: 'neom.com' })
    expect(out).toMatchObject({ status: 'verified', canVerify: false })
  })

  // THE RULE THAT CANNOT BREAK. A guess never earns a verified badge.
  it('never dresses a guess as verified', () => {
    const out = cardEmail({ item: item(), person: nader, domain: 'neom.com', pattern: { pattern: 'first.last', confidence: 'high', source: 'own' } })
    expect(out.status).toBe('guess')
    expect(out.badge).toBe('Guess')
    expect(out.explain).toContain('not confirmed')
  })

  it('says the guess came from addresses the customer already holds', () => {
    const out = cardEmail({ item: item(), person: nader, domain: 'neom.com', pattern: { pattern: 'first.last', confidence: 'high', source: 'own', sampleCount: 3 } })
    expect(out.email).toBe('nader.ashoor@neom.com')
    expect(out.explain).toContain('3 addresses you already hold')
  })

  // The privacy claim has to be on the card, not only in the code comments —
  // it is the thing a customer would want to know before trusting the guess.
  it('says plainly that a pooled format shared no addresses', () => {
    const out = cardEmail({ item: item(), person: nader, domain: 'neom.com', pattern: { pattern: 'flast', confidence: 'medium', source: 'pooled' } })
    expect(out.email).toBe('nashoor@neom.com')
    expect(out.explain).toContain('learns formats, never addresses')
    expect(out.explain).toContain("nobody's contacts were shared")
  })

  it('admits when it is only assuming the most common format', () => {
    const out = cardEmail({ item: item(), person: nader, domain: 'neom.com' })
    expect(out).toMatchObject({ email: 'nader.ashoor@neom.com', basis: 'assumed' })
    expect(out.explain).toContain('weakest kind of guess')
  })

  it('offers the Apollo check only when there is something to check', () => {
    expect(cardEmail({ item: item(), person: nader, domain: 'neom.com' }).canVerify).toBe(true)
    expect(cardEmail({ item: item(), person: { ...nader, email: 'x@neom.com' }, domain: 'neom.com' }).canVerify).toBe(false)
  })

  it('shows nothing rather than an empty row', () => {
    expect(cardEmail({ item: item(), person: nader, domain: null })).toBeNull()
    expect(cardEmail({ item: item(), person: null })).toBeNull()
    // A redacted LinkedIn surname cannot produce an address worth showing.
    expect(cardEmail({ item: item(), person: { name: 'Layla H' }, domain: 'khazna.ae' })).toBeNull()
  })
})
