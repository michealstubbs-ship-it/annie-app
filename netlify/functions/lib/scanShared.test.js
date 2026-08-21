// Regression tests for the exact fragile spots the pre-launch audit found:
// greedy JSON-extraction, dedup-key drift on legal-suffix variants, and
// eventDate values that were never checked for plausibility. Pure logic,
// no network calls, no Netlify runtime — this is the whole point of having
// pulled it out of the two scan functions in the first place.
import { describe, it, expect } from 'vitest'
import {
  extractJson, normalizeKey, toEventIso, resolveSignalType, splitToKeywords,
  mapLocationsToAdzunaCountries, SIGNAL_TYPES,
} from './scanShared.js'

describe('extractJson', () => {
  it('parses a clean JSON array', () => {
    const text = '[{"company":"Acme","headline":"Raises $10M"}]'
    expect(extractJson(text)).toEqual([{ company: 'Acme', headline: 'Raises $10M' }])
  })

  it('parses JSON wrapped in a ```json code fence', () => {
    const text = 'Here is what I found:\n```json\n[{"company":"Acme","headline":"Raises $10M"}]\n```\nHope that helps.'
    expect(extractJson(text)).toEqual([{ company: 'Acme', headline: 'Raises $10M' }])
  })

  it('ignores bracketed narration AFTER the real array — the case that broke the old greedy regex', () => {
    // A web-search tool-use response commonly interleaves narration between
    // searches. The old `/\[[\s\S]*\]/` regex matched from the first '[' to
    // the LAST ']' in the whole string, which would have swallowed the
    // trailing narration below and failed to parse. This must not happen.
    const text = '[{"company":"Acme","headline":"Raises $10M"}]\n\nI excluded these as duplicates: [BetaCo, GammaCo].'
    expect(extractJson(text)).toEqual([{ company: 'Acme', headline: 'Raises $10M' }])
  })

  it('ignores bracket characters inside a quoted string value', () => {
    const text = '[{"company":"Acme","headline":"Wins [Redacted] contract"}]'
    expect(extractJson(text)).toEqual([{ company: 'Acme', headline: 'Wins [Redacted] contract' }])
  })

  it('handles a nested array inside an object (titleKeywords) without breaking depth tracking', () => {
    const text = '[{"company":"Acme","titleKeywords":["CFO","Finance Director"]}]'
    expect(extractJson(text)).toEqual([{ company: 'Acme', titleKeywords: ['CFO', 'Finance Director'] }])
  })

  it('returns [] for genuinely empty or non-JSON text, never throws', () => {
    expect(extractJson('')).toEqual([])
    expect(extractJson('Nothing genuinely good was found.')).toEqual([])
    expect(extractJson(null)).toEqual([])
  })

  it('returns [] for malformed JSON rather than throwing', () => {
    expect(extractJson('[{"company": "Acme", headline: unquoted}]')).toEqual([])
  })
})

describe('normalizeKey (dedup)', () => {
  it('dedupes the same company across legal-suffix variants', () => {
    // This is the exact false-negative the audit flagged: before routing
    // through companyMatch.js's normalizeCompanyName, "Acme Ltd" and "Acme
    // Limited" produced two different dedup keys for the same real company.
    const a = normalizeKey('Acme Ltd', 'Raises $10M Series B')
    const b = normalizeKey('Acme Limited', 'Raises $10M Series B')
    expect(a).toBe(b)
  })

  it('still treats genuinely different companies as different', () => {
    const a = normalizeKey('Acme Ltd', 'Raises $10M Series B')
    const b = normalizeKey('Zenith Group', 'Raises $10M Series B')
    expect(a).not.toBe(b)
  })

  it('still treats genuinely different headlines about the same company as different', () => {
    const a = normalizeKey('Acme Ltd', 'Raises $10M Series B')
    const b = normalizeKey('Acme Ltd', 'Appoints new CFO')
    expect(a).not.toBe(b)
  })
})

describe('toEventIso (event date plausibility)', () => {
  it('accepts a genuinely recent date', () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    expect(toEventIso(yesterday)).not.toBeNull()
  })

  it('rejects a date more than a day in the future — a hallucinated or misread date', () => {
    const nextYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    expect(toEventIso(nextYear)).toBeNull()
  })

  it('rejects a date far too old to be a genuine "recent signal"', () => {
    expect(toEventIso('2019-01-01')).toBeNull()
  })

  it('rejects unparseable input rather than passing it through', () => {
    expect(toEventIso('not a date')).toBeNull()
    expect(toEventIso(null)).toBeNull()
    expect(toEventIso(undefined)).toBeNull()
  })
})

describe('resolveSignalType', () => {
  it('passes through a valid signal type unchanged', () => {
    expect(resolveSignalType('funding', '[test]')).toBe('funding')
  })

  it('falls back to public_commentary for an off-list value, without throwing', () => {
    expect(resolveSignalType('made_up_type', '[test]')).toBe('public_commentary')
    expect(resolveSignalType(undefined, '[test]')).toBe('public_commentary')
  })

  it('every real signal type is a valid fallback target (public_commentary is on the list)', () => {
    expect(SIGNAL_TYPES).toContain('public_commentary')
  })
})

describe('splitToKeywords', () => {
  it('splits a compound label on & and /', () => {
    expect(splitToKeywords('Strategy & Corporate Development')).toEqual(['Strategy', 'Corporate Development'])
    expect(splitToKeywords('Sales/Business Development')).toEqual(['Sales', 'Business Development'])
  })

  it('handles empty input without throwing', () => {
    expect(splitToKeywords('')).toEqual([])
    expect(splitToKeywords(null)).toEqual([])
  })
})

describe('mapLocationsToAdzunaCountries', () => {
  it('maps a covered market to its ISO code', () => {
    expect(mapLocationsToAdzunaCountries(['UK'])).toEqual(['gb'])
  })

  it('returns nothing for a market Adzuna does not cover, rather than guessing', () => {
    // This matters specifically because Annie's own onboarding markets
    // include GCC — Adzuna has no GCC coverage, and defaulting to a wrong
    // country would inject misleading job leads into the prompt for a
    // customer who never asked for that market.
    expect(mapLocationsToAdzunaCountries(['Dubai', 'GCC', 'UAE'])).toEqual([])
  })

  it('dedupes when multiple onboarding locations map to the same country', () => {
    expect(mapLocationsToAdzunaCountries(['UK', 'United Kingdom', 'Britain'])).toEqual(['gb'])
  })
})
