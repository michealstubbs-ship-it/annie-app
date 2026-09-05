import { describe, it, expect } from 'vitest'
import { nameParts, detectPatterns, learnPattern, guessEmail, domainOf, describePattern } from './emailPattern'

describe('nameParts', () => {
  it('handles the ordinary case', () => {
    expect(nameParts('Nader Ashoor')).toEqual({ first: 'nader', last: 'ashoor' })
  })

  it('drops honorifics and post-nominals, both of which are all over the real CRM', () => {
    expect(nameParts('Dr. Ahmed Musa')).toEqual({ first: 'ahmed', last: 'musa' })
    expect(nameParts('Ahmed Musa, PhD')).toEqual({ first: 'ahmed', last: 'musa' })
    expect(nameParts('Eng. Hamdan Alkalbani MBA')).toEqual({ first: 'hamdan', last: 'alkalbani' })
  })

  it('reverses "Last, First" but not "Name, PhD"', () => {
    expect(nameParts('Nilerud, Johan')).toEqual({ first: 'johan', last: 'nilerud' })
  })

  it('drops middle names rather than joining them', () => {
    expect(nameParts('Francesco Maria Marsella')).toEqual({ first: 'francesco', last: 'marsella' })
  })

  it('strips accents', () => {
    expect(nameParts('José Núñez')).toEqual({ first: 'jose', last: 'nunez' })
  })

  it('strips the LinkedIn parenthetical', () => {
    expect(nameParts('Carrie Hon (She/Her)')).toEqual({ first: 'carrie', last: 'hon' })
  })

  // The honesty cases. All three are real rows in the production account.
  it('refuses a redacted surname rather than building layla.h@', () => {
    expect(nameParts('Layla H')).toBeNull()
    expect(nameParts('Abdulrahim N')).toBeNull()
  })

  it('refuses a name in a script it cannot transliterate', () => {
    expect(nameParts('محمد المغيرة')).toBeNull()
  })

  it('refuses a single word', () => {
    expect(nameParts('Shatha')).toBeNull()
    expect(nameParts('')).toBeNull()
    expect(nameParts(null)).toBeNull()
  })
})

describe('detectPatterns', () => {
  it('reads the common formats back off an address', () => {
    expect(detectPatterns('Johan Nilerud', 'johan.nilerud@khazna.ae')).toContain('first.last')
    expect(detectPatterns('Johan Nilerud', 'jnilerud@khazna.ae')).toContain('flast')
    expect(detectPatterns('Johan Nilerud', 'nilerud.johan@khazna.ae')).toContain('last.first')
  })

  it('reports every format a short name is consistent with, rather than guessing one', () => {
    // "jo" + "li" is both firstlast and, if you read the j as an initial,
    // nothing else — but the ambiguity is real and counting beats picking.
    expect(detectPatterns('Jo Li', 'joli@x.com')).toEqual(expect.arrayContaining(['firstlast']))
  })

  it('ignores plus-addressing, which is the person routing their own mail', () => {
    expect(detectPatterns('Johan Nilerud', 'johan.nilerud+jobs@khazna.ae')).toContain('first.last')
  })

  it('says nothing when the address bears no relation to the name', () => {
    expect(detectPatterns('Johan Nilerud', 'info@khazna.ae')).toEqual([])
  })
})

describe('learnPattern', () => {
  const neom = [
    { name: 'Nader Ashoor', email: 'nader.ashoor@neom.com' },
    { name: 'Paul Potgieter', email: 'paul.potgieter@neom.com' },
    { name: 'Ahmad Alsinan', email: 'ahmad.alsinan@neom.com' },
  ]

  it('learns the format and rates it by how much evidence there is', () => {
    expect(learnPattern(neom)).toMatchObject({ pattern: 'first.last', agreeing: 3, confidence: 'high' })
    expect(learnPattern(neom.slice(0, 2))).toMatchObject({ confidence: 'medium' })
    expect(learnPattern(neom.slice(0, 1))).toMatchObject({ confidence: 'low' })
  })

  // THE BOUNDARY. This is the test that has to keep passing: what crosses a
  // tenant boundary is a format and a count, never an address and never a
  // name. Michael, 2026-09-05: "We will not steal exact emails of contacts
  // from our customers."
  it('returns a format and counts, and nothing that identifies anybody', () => {
    const out = learnPattern(neom)
    const serialised = JSON.stringify(out)
    expect(serialised).not.toContain('@')
    expect(serialised.toLowerCase()).not.toContain('ashoor')
    expect(serialised.toLowerCase()).not.toContain('neom')
    expect(Object.keys(out).sort()).toEqual(['agreeing', 'confidence', 'pattern', 'sampleCount'])
  })

  it('refuses when the organisation has no single convention', () => {
    expect(learnPattern([
      { name: 'Nader Ashoor', email: 'nader.ashoor@neom.com' },
      { name: 'Paul Potgieter', email: 'ppotgieter@neom.com' },
      { name: 'Ahmad Alsinan', email: 'ahmad_alsinan@neom.com' },
    ])).toBeNull()
  })

  it('counts a person once however many times they appear', () => {
    const dupes = [...neom, ...neom, ...neom]
    expect(learnPattern(dupes)).toMatchObject({ sampleCount: 3 })
  })

  it('survives junk', () => {
    expect(learnPattern([])).toBeNull()
    expect(learnPattern([null, {}, { email: 'x' }, { name: 'A B' }])).toBeNull()
    expect(learnPattern([{ name: 'Layla H', email: 'layla@neom.com' }])).toBeNull()
  })
})

describe('guessEmail', () => {
  it('builds from a learned format and says so', () => {
    expect(guessEmail({ name: 'Nader Ashoor', domain: 'neom.com', pattern: 'first.last', confidence: 'high' }))
      .toEqual({ email: 'nader.ashoor@neom.com', pattern: 'first.last', basis: 'observed', confidence: 'high' })
  })

  it('falls back to the most common corporate format and calls it an assumption', () => {
    expect(guessEmail({ name: 'Nader Ashoor', domain: 'neom.com' }))
      .toMatchObject({ email: 'nader.ashoor@neom.com', basis: 'assumed', confidence: 'low' })
  })

  it('tolerates a domain stored as a URL, which is how a third of them arrive', () => {
    expect(guessEmail({ name: 'Nader Ashoor', domain: 'https://www.neom.com/en-us' }))
      .toMatchObject({ email: 'nader.ashoor@neom.com' })
  })

  it('returns nothing rather than a guess it cannot stand behind', () => {
    expect(guessEmail({ name: 'Layla H', domain: 'khazna.ae' })).toBeNull()
    expect(guessEmail({ name: 'Nader Ashoor', domain: null })).toBeNull()
    expect(guessEmail({ name: 'Nader Ashoor', domain: 'Confidential' })).toBeNull()
    expect(guessEmail({})).toBeNull()
  })

  it('ignores a pattern key it does not recognise instead of trusting it', () => {
    expect(guessEmail({ name: 'Nader Ashoor', domain: 'neom.com', pattern: 'rm -rf' }))
      .toMatchObject({ basis: 'assumed', pattern: 'first.last' })
  })
})

describe('domainOf / describePattern', () => {
  it('pulls the domain off an address', () => {
    expect(domainOf('nader.ashoor@neom.com')).toBe('neom.com')
    expect(domainOf('not an address')).toBeNull()
  })

  it('describes a format in words a recruiter uses', () => {
    expect(describePattern('first.last')).toBe('firstname.lastname')
    expect(describePattern('flast')).toBe('initial + lastname')
  })
})
