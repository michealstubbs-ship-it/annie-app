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
    expect(flatEntry.keywords).toEqual(['talent acquisition', 'recruiter', 'recruitment manager', 'recruiting'])
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

// 2026-09-01 audit fix: real customer question ("would Annie find a CFO in
// Real Estate?") led to checking every C-suite title spelling, not just the
// abbreviation — see this file's own header for the real gap found (spelled-
// out "Chief Financial Officer"/"Chief Operating Officer" matched nothing,
// in any sector, before this fix).
describe('C-suite titles match on their full spelled-out form, not just the abbreviation', () => {
  it('"Chief Financial Officer" matches Finance & Accounting (previously only the "cfo" abbreviation did)', () => {
    expect(matches('chief financial officer', 'Finance & Accounting')).toBe(true)
  })

  it('"Chief Operating Officer" matches Operations & Supply Chain (previously only "coo" did)', () => {
    expect(matches('chief operating officer', 'Operations & Supply Chain')).toBe(true)
  })

  it('"Chief Information Officer" matches Technology, Data & Engineering (previously matched nothing at all)', () => {
    expect(matches('chief information officer', 'Technology, Data & Engineering')).toBe(true)
  })

  it('"Chief Product Officer" matches the narrowed Product Management sub-function (previously only "cpo" did)', () => {
    expect(matches('chief product officer', 'Technology, Data & Engineering > Product Management')).toBe(true)
  })

  it('the generic C-Suite bucket catches every spelled-out title, not just abbreviations', () => {
    expect(matches('chief financial officer', 'General Management / Executive Leadership > C-Suite')).toBe(true)
    expect(matches('chief operating officer', 'General Management / Executive Leadership > C-Suite')).toBe(true)
    expect(matches('chief information officer', 'General Management / Executive Leadership > C-Suite')).toBe(true)
  })
})

// 2026-09-01, same-day follow-up: a systematic sweep of every common "Chief
// ___ Officer" title against every whole-category function option (not just
// the 4 titles caught by hand above) found 8 more with no match anywhere in
// the taxonomy. See functionTaxonomy.js's own header for the full list and
// why each landed where it did.
describe('the 8 additional C-suite titles found by the systematic sweep', () => {
  it('Chief Commercial Officer matches Sales & Business Development', () => {
    expect(matches('chief commercial officer', 'Sales & Business Development')).toBe(true)
  })

  it('Chief Digital Officer matches Technology, Data & Engineering', () => {
    expect(matches('chief digital officer', 'Technology, Data & Engineering')).toBe(true)
  })

  it('Chief Diversity Officer matches HR & People', () => {
    expect(matches('chief diversity officer', 'HR & People')).toBe(true)
  })

  it('Chief Administrative Officer matches Administration & Office Support (neither "administration" nor "admin" is a substring of "administrative")', () => {
    expect(matches('chief administrative officer', 'Administration & Office Support')).toBe(true)
  })

  it('Chief Security Officer matches the narrowed Cybersecurity sub-function', () => {
    expect(matches('chief security officer', 'Technology, Data & Engineering > Cybersecurity')).toBe(true)
  })

  it('Chief Quality Officer matches HSE, Sustainability & Quality', () => {
    expect(matches('chief quality officer', 'HSE, Sustainability & Quality')).toBe(true)
  })

  it('Chief Customer Officer matches Customer Service & Success', () => {
    expect(matches('chief customer officer', 'Customer Service & Success')).toBe(true)
  })

  it('Chief Innovation Officer matches Strategy & Corporate Development', () => {
    expect(matches('chief innovation officer', 'Strategy & Corporate Development')).toBe(true)
  })

  it('the generic C-Suite bucket also catches all 8', () => {
    const label = 'General Management / Executive Leadership > C-Suite'
    for (const title of ['chief commercial officer', 'chief digital officer', 'chief diversity officer', 'chief administrative officer', 'chief security officer', 'chief quality officer', 'chief customer officer', 'chief innovation officer']) {
      expect(matches(title, label)).toBe(true)
    }
  })
})
