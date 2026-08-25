import { describe, it, expect } from 'vitest'
import { FUNCTION_TAXONOMY, FLAT_FUNCTION_OPTIONS, FUNCTION_PARENT_LABELS } from './functionTaxonomy.js'

// Same shape and same real-world consumer as sectorTaxonomy.js (see that
// file's test for the full rationale) — this matches a CONTACT'S OWN TITLE
// text rather than a company's industry text, via the same
// `options.some(o => o.keywords.some(k => titleText.includes(k)))`
// expression used in LinkedInImport.jsx's passesTitleFilters.
function matches(titleText, label) {
  const option = FLAT_FUNCTION_OPTIONS.find(o => o.label === label)
  if (!option) throw new Error(`no such option: ${label}`)
  return option.keywords.some(k => titleText.includes(k))
}

describe('FUNCTION_TAXONOMY shape', () => {
  it('every category has a label, a non-empty keyword list, and a non-empty subSectors list', () => {
    for (const cat of FUNCTION_TAXONOMY) {
      expect(typeof cat.label).toBe('string')
      expect(cat.label.length).toBeGreaterThan(0)
      expect(cat.keywords.length).toBeGreaterThan(0)
      expect(cat.subSectors.length).toBeGreaterThan(0)
    }
  })

  it('category labels are all unique', () => {
    const labels = FUNCTION_TAXONOMY.map(c => c.label)
    expect(new Set(labels).size).toBe(labels.length)
  })
})

describe('FLAT_FUNCTION_OPTIONS derivation', () => {
  it('has one entry per whole category plus one entry per sub-function', () => {
    const expectedCount = FUNCTION_TAXONOMY.reduce((n, c) => n + 1 + c.subSectors.length, 0)
    expect(FLAT_FUNCTION_OPTIONS.length).toBe(expectedCount)
  })

  it('labels a sub-function entry "Parent > Sub"', () => {
    expect(FLAT_FUNCTION_OPTIONS.some(o => o.label === 'Finance & Accounting > Treasury')).toBe(true)
  })

  it("a whole-category entry's keywords dedupe overlap between the category and its own sub-functions", () => {
    const flatEntry = FLAT_FUNCTION_OPTIONS.find(o => o.label === 'Legal & Compliance')
    // 'compliance' and 'regulatory' both appear on the category itself and on a sub-function.
    expect(flatEntry.keywords.filter(k => k === 'compliance').length).toBe(1)
    expect(flatEntry.keywords.filter(k => k === 'regulatory').length).toBe(1)
  })

  it("a sub-function entry's keywords are exactly that sub-function's own list", () => {
    const flatEntry = FLAT_FUNCTION_OPTIONS.find(o => o.label === 'HR & People > Talent Acquisition')
    expect(flatEntry.keywords).toEqual(['talent acquisition', 'recruiter', 'recruitment manager'])
  })
})

describe('FUNCTION_PARENT_LABELS', () => {
  it('is exactly the ordered list of category labels', () => {
    expect(FUNCTION_PARENT_LABELS).toEqual(FUNCTION_TAXONOMY.map(c => c.label))
  })
})

describe('keyword matching against realistic contact title text (the actual use case)', () => {
  it('matches a whole-category selection off a real job title', () => {
    expect(matches('finance director', 'Finance & Accounting')).toBe(true)
  })

  it('matches a narrowed sub-function selection precisely', () => {
    expect(matches('head of talent acquisition', 'HR & People > Talent Acquisition')).toBe(true)
  })

  it('does not match a narrowed sub-function selection against a different discipline\'s title', () => {
    expect(matches('head of talent acquisition', 'Finance & Accounting > Treasury')).toBe(false)
  })

  it('matches General Management / Executive Leadership > C-Suite on a CEO title', () => {
    expect(matches('group ceo', 'General Management / Executive Leadership > C-Suite')).toBe(true)
  })

  it('does not match on a completely unrelated title', () => {
    expect(matches('senior software engineer', 'Legal & Compliance > In-house Counsel')).toBe(false)
  })
})
