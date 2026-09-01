import { describe, it, expect } from 'vitest'
import {
  MARKET_OPTIONS, SENIORITY_OPTIONS, keywordMatches, normalizeCompany,
  passesFunctionFilter, passesSeniorityFilter, passesConnectionAge,
  passesTitleFilters, softGroupMatch, realGroupMatch, passesSectorMarket, matchesFilters,
} from './linkedinImportMatch.js'

// 2026-09-01: written after a direct question from Michael — is the LinkedIn
// CSV import's filtering really using every sector/function's SUB-sections
// (not just a single flat "Financial Services" example), and does it really
// handle MULTIPLE sector/function selections at once? These tests are the
// permanent, automated version of the manual verification run against this
// exact production code before this file existed — see the taxonomy files'
// own tests (functionTaxonomy.test.js, sectorTaxonomy.test.js) for the
// underlying union/narrow keyword math this builds on.

describe('passesFunctionFilter — whole-category selection includes every sub-discipline', () => {
  it('a whole "Finance & Accounting" selection catches a Treasury title, not just CFO-style titles', () => {
    expect(passesFunctionFilter('group treasurer', ['Finance & Accounting'])).toBe(true)
  })

  it('a whole "Finance & Accounting" selection catches an FP&A title', () => {
    expect(passesFunctionFilter('fp&a manager', ['Finance & Accounting'])).toBe(true)
  })

  it('a whole "Finance & Accounting" selection catches a Tax title', () => {
    expect(passesFunctionFilter('tax director', ['Finance & Accounting'])).toBe(true)
  })

  it('a whole "Technology, Data & Engineering" selection catches Cybersecurity, Data & Analytics, and Product titles alike', () => {
    expect(passesFunctionFilter('ciso', ['Technology, Data & Engineering'])).toBe(true)
    expect(passesFunctionFilter('senior data scientist', ['Technology, Data & Engineering'])).toBe(true)
    expect(passesFunctionFilter('head of product', ['Technology, Data & Engineering'])).toBe(true)
  })
})

describe('passesFunctionFilter — narrowing to one sub-discipline excludes its siblings', () => {
  it('narrowed to Treasury only, a pure Tax title is excluded', () => {
    expect(passesFunctionFilter('tax director', ['Finance & Accounting > Treasury'])).toBe(false)
  })

  it('narrowed to Treasury only, a Treasury title still matches', () => {
    expect(passesFunctionFilter('group treasurer', ['Finance & Accounting > Treasury'])).toBe(true)
  })
})

describe('passesFunctionFilter — multiple different function selections combine with OR, not AND', () => {
  const multi = ['Finance & Accounting', 'Technology, Data & Engineering', 'HR & People']

  it('a Data Scientist title matches via the Technology parent', () => {
    expect(passesFunctionFilter('senior data scientist', multi)).toBe(true)
  })

  it('a Talent Acquisition title matches via the HR parent', () => {
    expect(passesFunctionFilter('head of talent acquisition', multi)).toBe(true)
  })

  it('an unrelated Construction title matches none of the three selected functions', () => {
    expect(passesFunctionFilter('site manager', multi)).toBe(false)
  })

  it('mixing a whole parent with one narrowed sub from a DIFFERENT parent still matches both correctly', () => {
    const mixed = ['HR & People', 'Technology, Data & Engineering > Cybersecurity']
    expect(passesFunctionFilter('hr business partner', mixed)).toBe(true) // whole HR parent
    expect(passesFunctionFilter('ciso', mixed)).toBe(true) // narrowed Cybersecurity sub
    expect(passesFunctionFilter('software engineer', mixed)).toBe(false) // different sub, same parent, not selected
  })

  it('an empty selection passes everything (no function filter applied)', () => {
    expect(passesFunctionFilter('anything at all', [])).toBe(true)
  })
})

describe('passesSeniorityFilter', () => {
  it('"Any level" (or an empty selection) passes everything', () => {
    expect(passesSeniorityFilter('junior analyst', ['Any level'])).toBe(true)
    expect(passesSeniorityFilter('junior analyst', [])).toBe(true)
  })

  it('C-Suite selection matches a CFO title', () => {
    expect(passesSeniorityFilter('cfo', ['C-Suite / Partner / MD'])).toBe(true)
  })

  it('C-Suite selection excludes a plain Manager title', () => {
    expect(passesSeniorityFilter('operations manager', ['C-Suite / Partner / MD'])).toBe(false)
  })

  it('multiple seniority bands combine with OR', () => {
    expect(passesSeniorityFilter('operations manager', ['Manager+', 'C-Suite / Partner / MD'])).toBe(true)
  })
})

describe('passesConnectionAge', () => {
  it('no connectedOn date passes regardless of the years filter', () => {
    expect(passesConnectionAge('', 1)).toBe(true)
    expect(passesConnectionAge(undefined, 1)).toBe(true)
  })

  it('an unparseable date passes rather than wrongly excluding', () => {
    expect(passesConnectionAge('not a date', 1)).toBe(true)
  })

  it('a connection within the window passes', () => {
    const recent = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days ago
    expect(passesConnectionAge(recent, 5)).toBe(true)
  })

  it('a connection older than the window is excluded', () => {
    const old = new Date(Date.now() - 10 * 365 * 24 * 60 * 60 * 1000).toISOString() // 10 years ago
    expect(passesConnectionAge(old, 5)).toBe(false)
  })
})

describe('passesTitleFilters — combines function, seniority, and connection age', () => {
  it('a real VP of People contact passes an HR & People function filter (parent-level "people" keyword, no narrowing needed)', () => {
    const contact = { title: 'VP of People', company: 'Acme Group', connectedOn: '' }
    expect(passesTitleFilters(contact, { functions: ['HR & People'], seniority: ['Any level'], years: 10 })).toBe(true)
  })

  it('fails when the function matches but seniority does not', () => {
    const contact = { title: 'HR Coordinator', company: 'Acme Group', connectedOn: '' }
    expect(passesTitleFilters(contact, { functions: ['HR & People'], seniority: ['C-Suite / Partner / MD'], years: 10 })).toBe(false)
  })
})

describe('softGroupMatch / realGroupMatch — sector & market keyword-group matching', () => {
  it('softGroupMatch keeps a contact when their company name gives no signal either way', () => {
    expect(softGroupMatch('acme holdings llc', MARKET_OPTIONS, ['UAE / GCC'])).toBe(true)
  })

  it('softGroupMatch excludes a company name that confidently signals a different, unselected market', () => {
    expect(softGroupMatch('acme london ltd', MARKET_OPTIONS, ['UAE / GCC'])).toBe(false)
  })

  it('realGroupMatch confirms a real match against verified data', () => {
    expect(realGroupMatch('dubai, uae', MARKET_OPTIONS, ['UAE / GCC'])).toBe(true)
  })

  it('realGroupMatch excludes verified data that confirms a different, unselected market', () => {
    expect(realGroupMatch('london, united kingdom', MARKET_OPTIONS, ['UAE / GCC'])).toBe(false)
  })

  it('"Global" in the selection always passes, on both the soft and real path', () => {
    expect(softGroupMatch('acme london ltd', MARKET_OPTIONS, ['Global'])).toBe(true)
    expect(realGroupMatch('london, united kingdom', MARKET_OPTIONS, ['Global'])).toBe(true)
  })
})

describe('passesSectorMarket — whole-sector selection covers its sub-sectors, real Apollo data takes priority over name guessing', () => {
  it('a whole "Financial Services" selection catches an Insurance company by name (soft match, no Apollo data)', () => {
    const contact = { company: 'Acme Insurance Group' }
    expect(passesSectorMarket(contact, { sectors: ['Financial Services'], markets: ['Global'], companyData: {} })).toBe(true)
  })

  it('a whole "Financial Services" selection catches a Fintech company by name', () => {
    const contact = { company: 'Acme Fintech Payments' }
    expect(passesSectorMarket(contact, { sectors: ['Financial Services'], markets: ['Global'], companyData: {} })).toBe(true)
  })

  it('narrowed to Financial Services > Insurance, a pure Fintech company name is excluded', () => {
    const contact = { company: 'Acme Fintech Payments' }
    expect(passesSectorMarket(contact, { sectors: ['Financial Services > Insurance'], markets: ['Global'], companyData: {} })).toBe(false)
  })

  it('real Apollo-verified industry data overrides a misleading company name', () => {
    const contact = { company: 'Acme Digital' } // name gives no sector signal at all
    const companyData = { 'acme digital': { matched: true, industry: 'Investment Banking', city: '', state: '', country: '' } }
    expect(passesSectorMarket(contact, { sectors: ['Financial Services'], markets: ['Global'], companyData })).toBe(true)
  })

  it('real Apollo-verified industry data confidently excludes a company outside every selected sector', () => {
    const contact = { company: 'Acme Digital' }
    const companyData = { 'acme digital': { matched: true, industry: 'Manufacturing', city: '', state: '', country: '' } }
    expect(passesSectorMarket(contact, { sectors: ['Financial Services'], markets: ['Global'], companyData })).toBe(false)
  })
})

describe('normalizeCompany — 2026-09-01 audit fix: same company, different legal-suffix spelling, must key the same (prevents a duplicate Companies row on import)', () => {
  it('a plain name and its FZE-suffixed variant normalize identically (the exact scenario Michael asked about — one contact at "X", another later at "X FZE")', () => {
    expect(normalizeCompany('Acme Trading')).toBe(normalizeCompany('Acme Trading FZE'))
  })

  it('agrees with Companies.jsx\'s own dedup function (companyMatch.js\'s normalizeCompanyName) rather than being a second, independent implementation', () => {
    expect(normalizeCompany('Acme Trading W.L.L.')).toBe(normalizeCompany('Acme Trading'))
    expect(normalizeCompany('Acme Ltd.')).toBe(normalizeCompany('ACME'))
  })

  it('still tells apart two genuinely different company names', () => {
    expect(normalizeCompany('Acme Trading')).not.toBe(normalizeCompany('Zenith Holdings'))
  })
})

// 2026-09-01: written after Michael's direct question — "would Annie find a
// CFO, Chief Strategy Officer, CTO in Real Estate?" — after he saw two
// SIMILAR-LOOKING pickers: the SECTOR taxonomy's "Real Estate" (an industry —
// Development, Investment & Asset Management, Property Management, Proptech)
// and the FUNCTION taxonomy's "Real Estate, Facilities & Hospitality" (a job
// discipline — property/facilities/hospitality management roles only). These
// are two independent, ANDed filters, not one combined list: Sector narrows
// by the COMPANY's industry, Function narrows by the CANDIDATE's own role,
// and a search can combine any sector with any function. Selecting only the
// Real Estate FUNCTION category would in fact miss a CFO/CTO/CSO — it's not
// meant to cover them, the same way "Finance & Accounting" isn't meant to
// cover a facilities manager. The fix here is real (see functionTaxonomy.js's
// own 2026-09-01 header) for a different, related gap this surfaced: a
// spelled-out "Chief Financial Officer"/"Chief Operating Officer" title
// matched no function category at all, in any sector, before that fix.
describe('Real Estate sector + C-suite functions — the exact scenario Michael asked about', () => {
  const filtersFor = (functions) => ({ functions, seniority: ['Any level'], years: 50, sectors: ['Real Estate'], markets: ['Global'], companyData: {} })

  it('a CFO at a Real Estate developer is found when Function = Finance & Accounting (not the Real Estate function category)', () => {
    const contact = { title: 'Chief Financial Officer', company: 'Acme Properties Development', connectedOn: '' }
    expect(matchesFilters(contact, filtersFor(['Finance & Accounting']))).toBe(true)
  })

  it('a CTO at a Real Estate developer is found when Function = Technology, Data & Engineering', () => {
    const contact = { title: 'Chief Technology Officer', company: 'Acme Properties Development', connectedOn: '' }
    expect(matchesFilters(contact, filtersFor(['Technology, Data & Engineering']))).toBe(true)
  })

  it('a Chief Strategy Officer at a Real Estate developer is found when Function = Strategy & Corporate Development', () => {
    const contact = { title: 'Chief Strategy Officer', company: 'Acme Properties Development', connectedOn: '' }
    expect(matchesFilters(contact, filtersFor(['Strategy & Corporate Development']))).toBe(true)
  })

  it('the same CFO is correctly MISSED if only the Real Estate FUNCTION category is selected — it is not meant to cover finance leadership', () => {
    const contact = { title: 'Chief Financial Officer', company: 'Acme Properties Development', connectedOn: '' }
    expect(matchesFilters(contact, filtersFor(['Real Estate, Facilities & Hospitality']))).toBe(false)
  })

  it('a property manager at the same company IS found via the Real Estate function category', () => {
    const contact = { title: 'Head of Property Management', company: 'Acme Properties Development', connectedOn: '' }
    expect(matchesFilters(contact, filtersFor(['Real Estate, Facilities & Hospitality']))).toBe(true)
  })

  it('selecting BOTH the Real Estate function and Finance & Accounting at once catches both the property manager and the CFO (multi-select OR)', () => {
    const both = filtersFor(['Real Estate, Facilities & Hospitality', 'Finance & Accounting'])
    expect(matchesFilters({ title: 'Head of Property Management', company: 'Acme Properties Development', connectedOn: '' }, both)).toBe(true)
    expect(matchesFilters({ title: 'Chief Financial Officer', company: 'Acme Properties Development', connectedOn: '' }, both)).toBe(true)
  })
})

describe('matchesFilters — the full combined gate, multiple sectors AND multiple functions at once', () => {
  it('a VP of People at a Fintech company passes when both Financial Services and HR & People are selected', () => {
    const contact = { title: 'VP of People', company: 'Acme Fintech Payments', connectedOn: '' }
    const filters = { functions: ['HR & People'], seniority: ['Any level'], years: 10, sectors: ['Financial Services'], markets: ['Global'], companyData: {} }
    expect(matchesFilters(contact, filters)).toBe(true)
  })

  it('the same contact fails when the selected sector does not include Financial Services', () => {
    const contact = { title: 'VP of People', company: 'Acme Fintech Payments', connectedOn: '' }
    const filters = { functions: ['HR & People'], seniority: ['Any level'], years: 10, sectors: ['Healthcare'], markets: ['Global'], companyData: {} }
    expect(matchesFilters(contact, filters)).toBe(false)
  })
})
