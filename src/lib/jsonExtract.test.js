// Regression tests for the exact fragile spot the pre-launch audit found:
// a greedy JSON-extraction regex that matched from the first '[' to the
// LAST ']' in the entire response. Moved here from
// netlify/functions/lib/scanShared.test.js when extractJson itself moved —
// see jsonExtract.js for why this now lives in src/lib rather than being
// backend-only.
import { describe, it, expect } from 'vitest'
import { extractJson } from './jsonExtract.js'

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

  // 2026-08-26 audit fix: narration BEFORE the array, when that narration
  // itself contains a bracket character, used to make this give up
  // entirely — the first '[' (inside the narration) balanced to a
  // syntactically-closed-but-invalid slice, JSON.parse threw, and the whole
  // call returned [] without ever trying the real array right after it.
  it('skips past bracketed narration BEFORE the real array and still finds it', () => {
    const text = 'I checked their competitors [Acme, Beta] first.\n[{"company":"Acme","headline":"Raises $10M"}]'
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
