// Regression coverage for the shared sanitizer both scanShared.js (server
// side, at signal write-time) and TodaysActions.jsx (client side, the
// per-candidate pitch call) route every AI-written field through — see this
// file's own header for why it's one implementation now instead of two.
import { describe, it, expect } from 'vitest'
import { stripAiArtifacts, sanitizeStringList } from './textSanitize.js'

describe('stripAiArtifacts', () => {
  it('strips <cite index="..."> markup the model sometimes emits during web search', () => {
    expect(stripAiArtifacts('Raises new fund <cite index="1-2">[1]</cite>')).toBe('Raises new fund')
  })

  it('strips stray numeric footnote markers like [1] or [2, 3]', () => {
    expect(stripAiArtifacts('This signals fresh capital for hiring.[2, 3]')).toBe('This signals fresh capital for hiring.')
  })

  it('collapses repeated whitespace left behind after stripping', () => {
    expect(stripAiArtifacts('The CFO <cite index="5-1">is the right door</cite>.')).toBe('The CFO is the right door.')
  })

  it('passes plain text through unchanged', () => {
    expect(stripAiArtifacts('A strong candidate is available.')).toBe('A strong candidate is available.')
  })

  it('handles empty/null/undefined input without throwing', () => {
    expect(stripAiArtifacts('')).toBe('')
    expect(stripAiArtifacts(null)).toBeNull()
    expect(stripAiArtifacts(undefined)).toBeUndefined()
  })
})

describe('sanitizeStringList', () => {
  it('bounds a list to the given max length', () => {
    expect(sanitizeStringList(['A', 'B', 'C', 'D'], 2)).toEqual(['A', 'B'])
  })

  it('strips artifacts out of each entry', () => {
    expect(sanitizeStringList(['Rival Co <cite index="1-1">[1]</cite>'], 3)).toEqual(['Rival Co'])
  })

  it('filters out non-string and empty entries', () => {
    expect(sanitizeStringList(['Real Co', '', null, 42, undefined], 5)).toEqual(['Real Co'])
  })

  it('returns an empty array for non-array input rather than throwing', () => {
    expect(sanitizeStringList(null, 3)).toEqual([])
    expect(sanitizeStringList(undefined, 3)).toEqual([])
    expect(sanitizeStringList('not an array', 3)).toEqual([])
  })
})
