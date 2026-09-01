// Pure matching logic for the LinkedIn CSV import filters (Connections.csv),
// split out of LinkedInImport.jsx so it's directly unit-testable — same
// convention this codebase already uses elsewhere for pure-logic/JSX splits
// (see supportEscalation.js's own header for the precedent). This is a
// straight extraction: no behavior change from what shipped in the page
// component, just given real test coverage it never had as a closure.
//
// 2026-09-01: added after a real gap was found — the taxonomy's own
// union/narrow-selection math was tested (functionTaxonomy.test.js,
// sectorTaxonomy.test.js), and manually verified correct for multi-select
// (multiple sectors/functions chosen at once, mixed whole-category + one
// narrowed sub from a different category), but nothing locked that
// combination in as a permanent test against the REAL page logic. It was
// only checked by hand, once, against a copy of the code. This file plus its
// test closes that: the page now imports and calls this, so a regression
// here is a real caught test failure, not something that has to be manually
// re-verified again next time.
import { FLAT_SECTOR_OPTIONS } from './sectorTaxonomy'
import { FLAT_FUNCTION_OPTIONS } from './functionTaxonomy'

// Sector and market keywords serve two purposes: (1) matched against a company's real
// Apollo industry/country data when we have it, confidently excluding a confirmed
// mismatch, and (2) matched against company NAME text as a fallback for companies
// Apollo has no data on, where a match is weak evidence so absence of a match is never
// treated as a mismatch (see softGroupMatch below). Sectors themselves live in
// sectorTaxonomy.js, shared with onboarding so the two can never drift apart again.
export const MARKET_OPTIONS = [
  { label: 'UAE / GCC', keywords: ['dubai', 'abu dhabi', 'sharjah', 'uae', 'united arab emirates', 'emirates', 'gulf', 'gcc', 'qatar', 'doha', 'saudi arabia', 'saudi', 'ksa', 'riyadh', 'jeddah', 'bahrain', 'kuwait', 'oman', 'difc', 'adgm'] },
  { label: 'United Kingdom', keywords: ['uk', 'london', 'britain', 'united kingdom', 'england', 'scotland', 'manchester', 'edinburgh'] },
  { label: 'United States', keywords: ['usa', 'united states', 'america', 'new york', 'california', 'chicago', 'boston', 'texas'] },
  { label: 'Europe', keywords: ['europe', 'france', 'germany', 'netherlands', 'switzerland', 'spain', 'italy', 'ireland', 'portugal', 'belgium', 'sweden', 'denmark', 'norway', 'poland', 'austria', 'paris', 'berlin', 'frankfurt', 'amsterdam', 'zurich', 'geneva', 'madrid', 'milan', 'dublin'] },
  { label: 'Asia Pacific', keywords: ['singapore', 'hong kong', 'japan', 'australia', 'china', 'south korea', 'indonesia', 'malaysia', 'thailand', 'vietnam', 'philippines', 'india', 'tokyo', 'sydney', 'shanghai', 'apac'] },
  { label: 'Global', keywords: [] },
]
// Functions themselves live in functionTaxonomy.js, shared with onboarding, same
// reasoning as sectors above.
export const SENIORITY_OPTIONS = [
  { label: 'Any level', keywords: [] },
  { label: 'Manager+', keywords: ['manager', 'lead', 'head'] },
  { label: 'Director / VP+', keywords: ['director', 'vp', 'vice president', 'head of'] },
  { label: 'C-Suite / Partner / MD', keywords: ['ceo', 'cfo', 'coo', 'cto', 'chro', 'cmo', 'chief', 'partner', 'managing director', 'president', 'founder', 'md'] },
]

export function normalizeCompany(name) {
  return (name || '').trim().toLowerCase()
}

// 2026-08-26 audit fix: every keyword check on this page used plain
// `.includes()` against raw title/company text — a substring match with
// no word-boundary check at all. Several real taxonomy keywords are
// short (functionTaxonomy.js has 'hr', 'pr', 'tax'; sectorTaxonomy.js has
// 'ey', 'gas', 'oil') and matched INSIDE unrelated words: 'hr' matches
// "Ba-hr-ain", 'ey' (Ernst & Young's own abbreviation) matches "Turk-ey"
// or "attorn-ey", 'gas' matches "Ve-gas". A contact at a Bahrain-based
// firm could get pulled into an "HR & People" function filter they have
// nothing to do with, or a real Ernst & Young contact could get missed
// entirely if a keyword collision elsewhere in the same matching pass
// produces a false exclusion. Fixed with a boundary check that treats a
// keyword's own leading/trailing punctuation as already self-bounding
// (so 'fp&a' or 'm&a' still match correctly right up against a following
// space) while still requiring a real word boundary on any side that
// starts/ends with a letter or digit — this is deliberately NOT a regex
// \b check, since \b behaves inconsistently right at a keyword's own
// trailing punctuation (e.g. 'strategy&' followed by a space has no \b
// between the two non-word characters, which would silently stop
// matching a case it should catch).
export function keywordMatches(text, keyword) {
  if (!keyword) return false
  const isWordChar = (ch) => !!ch && /[a-z0-9]/i.test(ch)
  let from = 0
  while (true) {
    const idx = text.indexOf(keyword, from)
    if (idx === -1) return false
    const before = text[idx - 1]
    const after = text[idx + keyword.length]
    const startOk = !isWordChar(keyword[0]) || !isWordChar(before)
    const endOk = !isWordChar(keyword[keyword.length - 1]) || !isWordChar(after)
    if (startOk && endOk) return true
    from = idx + 1
  }
}

// FLAT_FUNCTION_OPTIONS has one entry per whole parent function (keywords =
// union of the parent's own words + every one of its sub-disciplines' words)
// and one entry per individually narrowed "Parent > Sub" selection (keywords
// = just that sub's own tighter list) — see functionTaxonomy.js's own header.
// selectedFunctionLabels can hold any mix of whole-parent and narrowed-sub
// labels at once; matching is OR across all of them, a candidate needs to
// fit ANY one selected group, not all.
export function passesFunctionFilter(titleText, selectedFunctionLabels) {
  if (!selectedFunctionLabels?.length) return true
  const selectedFns = FLAT_FUNCTION_OPTIONS.filter(f => selectedFunctionLabels.includes(f.label))
  return selectedFns.some(f => f.keywords.some(k => keywordMatches(titleText, k)))
}

export function passesSeniorityFilter(titleText, selectedSeniorityLabels) {
  if (!selectedSeniorityLabels?.length || selectedSeniorityLabels.includes('Any level')) return true
  const selectedSen = SENIORITY_OPTIONS.filter(s => selectedSeniorityLabels.includes(s.label))
  return selectedSen.some(s => s.keywords.some(k => keywordMatches(titleText, k)))
}

export function passesConnectionAge(connectedOn, years) {
  if (!connectedOn) return true
  const parsed = Date.parse(connectedOn)
  if (isNaN(parsed)) return true
  const yearsAgo = (Date.now() - parsed) / (1000 * 60 * 60 * 24 * 365)
  return yearsAgo <= years
}

// These three are cheap and reliable, straight off the CSV's title text, no API call needed.
export function passesTitleFilters(contact, { functions, seniority, years }) {
  const titleText = `${contact.title} ${contact.company}`.toLowerCase()
  if (!passesFunctionFilter(titleText, functions)) return false
  if (!passesSeniorityFilter(titleText, seniority)) return false
  if (!passesConnectionAge(contact.connectedOn, years)) return false
  return true
}

// Company name alone is a weak signal, most names don't spell out sector or
// geography. So this only excludes a contact when their company name confidently
// signals a group OTHER than the ones selected. No signal at all is not treated as
// a mismatch, the contact is kept rather than wrongly dropped. Used when Apollo has
// no enrichment data for that company.
export function softGroupMatch(companyText, options, selectedLabels) {
  if (!selectedLabels?.length || selectedLabels.includes('Global')) return true
  const signaled = options.filter(o => o.keywords.length && o.keywords.some(k => keywordMatches(companyText, k)))
  if (!signaled.length) return true // no evidence either way, don't exclude
  return signaled.some(o => selectedLabels.includes(o.label))
}

// With real Apollo data, a confirmed industry/location that doesn't match any
// selected option is a confident exclusion, not a guess.
export function realGroupMatch(dataText, options, selectedLabels) {
  if (!selectedLabels?.length || selectedLabels.includes('Global')) return true
  const selected = options.filter(o => selectedLabels.includes(o.label))
  return selected.some(o => o.keywords.some(k => keywordMatches(dataText, k)))
}

// companyData: normalized company name -> { industry, city, state, country, matched } (Apollo enrichment cache)
export function passesSectorMarket(contact, { sectors, markets, companyData }) {
  const companyText = `${contact.company}`.toLowerCase()
  const enrichment = companyData?.[normalizeCompany(contact.company)]

  if (enrichment?.matched && enrichment.industry) {
    if (!realGroupMatch(enrichment.industry.toLowerCase(), FLAT_SECTOR_OPTIONS, sectors)) return false
  } else if (!softGroupMatch(companyText, FLAT_SECTOR_OPTIONS, sectors)) {
    return false
  }

  if (enrichment?.matched && (enrichment.city || enrichment.state || enrichment.country)) {
    const locText = `${enrichment.city || ''} ${enrichment.state || ''} ${enrichment.country || ''}`.toLowerCase()
    if (!realGroupMatch(locText, MARKET_OPTIONS, markets)) return false
  } else if (!softGroupMatch(companyText, MARKET_OPTIONS, markets)) {
    return false
  }

  return true
}

export function matchesFilters(contact, filters) {
  return passesTitleFilters(contact, filters) && passesSectorMarket(contact, filters)
}
