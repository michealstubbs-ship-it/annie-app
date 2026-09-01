import { describe, it, expect } from 'vitest'
import { SECTOR_TAXONOMY, FLAT_SECTOR_OPTIONS, SECTOR_PARENT_LABELS } from './sectorTaxonomy.js'

// This module exports data only (no matching function of its own) — the
// actual keyword matching happens in LinkedInImport.jsx's realGroupMatch /
// softGroupMatch, both of which just do
// `options.some(o => o.keywords.some(k => text.includes(k)))` against
// FLAT_SECTOR_OPTIONS. These tests cover (1) the shape/derivation of the
// exported data and (2) that shape actually working correctly when driven
// through that exact real-world matching expression, since that's the whole
// point of a "flat option with keywords" shape existing at all.
function matches(text, label) {
  const option = FLAT_SECTOR_OPTIONS.find(o => o.label === label)
  if (!option) throw new Error(`no such option: ${label}`)
  return option.keywords.some(k => text.includes(k))
}

describe('SECTOR_TAXONOMY shape', () => {
  it('every category has a label, a non-empty keyword list, and a non-empty subSectors list', () => {
    for (const cat of SECTOR_TAXONOMY) {
      expect(typeof cat.label).toBe('string')
      expect(cat.label.length).toBeGreaterThan(0)
      expect(cat.keywords.length).toBeGreaterThan(0)
      expect(cat.subSectors.length).toBeGreaterThan(0)
    }
  })

  it('every sub-sector has a label and a non-empty keyword list', () => {
    for (const cat of SECTOR_TAXONOMY) {
      for (const sub of cat.subSectors) {
        expect(typeof sub.label).toBe('string')
        expect(sub.keywords.length).toBeGreaterThan(0)
      }
    }
  })

  it('category labels are all unique', () => {
    const labels = SECTOR_TAXONOMY.map(c => c.label)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('"Executive Search" was deliberately removed and must not reappear', () => {
    expect(SECTOR_TAXONOMY.some(c => c.label === 'Executive Search')).toBe(false)
  })
})

describe('FLAT_SECTOR_OPTIONS derivation', () => {
  it('has one entry per whole category plus one entry per sub-sector', () => {
    const expectedCount = SECTOR_TAXONOMY.reduce((n, c) => n + 1 + c.subSectors.length, 0)
    expect(FLAT_SECTOR_OPTIONS.length).toBe(expectedCount)
  })

  it('labels a whole-category entry with just the parent label', () => {
    expect(FLAT_SECTOR_OPTIONS.some(o => o.label === 'Financial Services')).toBe(true)
  })

  it('labels a sub-sector entry "Parent > Sub"', () => {
    expect(FLAT_SECTOR_OPTIONS.some(o => o.label === 'Financial Services > Investment Banking')).toBe(true)
  })

  it("a whole-category entry's keywords are the union (deduped) of its own keywords and every sub-sector's keywords", () => {
    const financial = SECTOR_TAXONOMY.find(c => c.label === 'Financial Services')
    const flatEntry = FLAT_SECTOR_OPTIONS.find(o => o.label === 'Financial Services')
    // 'fintech' and 'payments' both appear on the category itself AND on the
    // Fintech & Payments sub-sector — dedup must collapse them to one copy.
    const fintechCount = flatEntry.keywords.filter(k => k === 'fintech').length
    expect(fintechCount).toBe(1)
    for (const k of financial.keywords) expect(flatEntry.keywords).toContain(k)
    for (const sub of financial.subSectors) {
      for (const k of sub.keywords) expect(flatEntry.keywords).toContain(k)
    }
  })

  it("a sub-sector entry's keywords are exactly that sub-sector's own list, not the parent's", () => {
    // "Legal" was renamed to "Law" (25 Aug 2026) — update the label this test
    // reads, not what it asserts about sub-sector keyword isolation.
    const flatEntry = FLAT_SECTOR_OPTIONS.find(o => o.label === 'Law > Litigation & Disputes')
    expect(flatEntry.keywords).toEqual(['litigation', 'disputes', 'arbitration'])
  })
})

describe('SECTOR_PARENT_LABELS', () => {
  it('is exactly the ordered list of category labels', () => {
    expect(SECTOR_PARENT_LABELS).toEqual(SECTOR_TAXONOMY.map(c => c.label))
  })
})

describe('keyword matching against realistic company industry text (the actual use case)', () => {
  it('matches a whole-category selection off a sub-sector-specific industry phrase', () => {
    expect(matches('provider of commercial banking services', 'Financial Services')).toBe(true)
  })

  it('matches a narrowed sub-sector selection precisely', () => {
    expect(matches('leading investment bank and capital markets advisor', 'Financial Services > Investment Banking')).toBe(true)
  })

  it('does not match a narrowed sub-sector selection against a different sub-sector\'s text', () => {
    expect(matches('life sciences and biotech research', 'Financial Services > Investment Banking')).toBe(false)
  })

  it('matches Technology > AI & Data on real industry phrasing', () => {
    expect(matches('provider of machine learning and data science tooling', 'Technology > AI & Data')).toBe(true)
  })

  it('does not match on totally unrelated industry text', () => {
    expect(matches('independent oil and gas exploration company', 'Law > Litigation & Disputes')).toBe(false)
  })
})

// 2026-09-01: 4 sub-sectors promoted to their own top-level sector, approved
// by Michael. See this file's own header comment for the full rationale.
describe('2026-09-01 sector promotions — Construction, Manufacturing, Education, Marketing/Media/Advertising', () => {
  it('are present as their own top-level sectors', () => {
    for (const label of ['Construction', 'Manufacturing', 'Education', 'Marketing, Media & Advertising']) {
      expect(SECTOR_PARENT_LABELS).toContain(label)
    }
  })

  it('match real industry phrasing on their own whole-category selection', () => {
    expect(matches('leading general contractor and main contractor for commercial construction', 'Construction')).toBe(true)
    expect(matches('heavy manufacturing and industrial manufacturing group', 'Manufacturing')).toBe(true)
    expect(matches('higher education university', 'Education')).toBe(true)
    expect(matches('full-service advertising agency and creative agency', 'Marketing, Media & Advertising')).toBe(true)
  })

  it('narrowed sub-sector picks work precisely for each new sector', () => {
    expect(matches('specialist mep contractor and fit-out contractor', 'Construction > Specialist & MEP Contracting')).toBe(true)
    expect(matches('automotive manufacturer and oem auto parts manufacturer', 'Manufacturing > Automotive Manufacturing')).toBe(true)
    expect(matches('edtech e-learning platform for schools', 'Education > EdTech')).toBe(true)
    expect(matches('television network and broadcasting group', 'Marketing, Media & Advertising > Media & Broadcasting')).toBe(true)
  })

  it('Industrial no longer carries Manufacturing or Engineering & Construction as sub-sectors', () => {
    const industrial = SECTOR_TAXONOMY.find(c => c.label === 'Industrial')
    const subLabels = industrial.subSectors.map(s => s.label)
    expect(subLabels).not.toContain('Manufacturing')
    expect(subLabels).not.toContain('Engineering & Construction')
    expect(subLabels).toEqual(['Logistics & Supply Chain', 'Automotive'])
  })

  it('selecting the whole "Industrial" sector no longer matches a pure construction/manufacturing company', () => {
    expect(matches('general contractor specializing in commercial construction', 'Industrial')).toBe(false)
    expect(matches('heavy machinery and metal parts factory production', 'Industrial')).toBe(false)
  })

  it('Government & Public Sector no longer carries Education as a sub-sector', () => {
    const gov = SECTOR_TAXONOMY.find(c => c.label === 'Government & Public Sector')
    expect(gov.subSectors.map(s => s.label)).not.toContain('Education')
  })
})
