// Turning a contact row into something you can rank.
//
// Measured on a real account before this existed: 753 imported contacts where
// `status` read 'cold' on 752 of them, `tags` read 'linkedin-import' on 752,
// `notes` was empty on all 753 and `last_contacted` was null on all 753. Only
// name, company and title differed between any two rows. There was nothing to
// sort or group by, which is why a CRM holding 600 senior relationships felt
// like a spreadsheet.
//
// Everything here is derived from title text the import ALREADY reads. No API
// call, no Apollo credit, no second import. The import currently computes
// almost exactly this to run its own filters and then discards the result.
//
// ONE DEFINITION, DELIBERATELY. The vocabularies are imported, not restated:
// SENIORITY_OPTIONS from linkedinImportMatch.js and FLAT_FUNCTION_OPTIONS from
// functionTaxonomy.js, matched with that file's own keywordMatches() and its
// word-boundary handling (the one that stops 'hr' matching "Ba-hr-ain" and
// 'ey' matching "Turk-ey"). This codebase has had to fix a silently-diverging
// second implementation three times — the scan-prompt fork, the RACY_TYPES
// fork, the company-normalisation fork — and a Postgres regex doing this job
// would have been the fourth. That is why the SQL migration adds the columns
// and classifies nothing.
import { SENIORITY_OPTIONS, keywordMatches } from './linkedinImportMatch'
import { FLAT_FUNCTION_OPTIONS } from './functionTaxonomy'

// Ordered high to low. Ranking reads these, so the order is the meaning.
export const SENIORITY_BANDS = [
  { key: 'c_suite', label: 'C-suite / Partner / MD', from: 'C-Suite / Partner / MD' },
  { key: 'director_vp', label: 'Director / VP / Head', from: 'Director / VP+' },
  { key: 'manager_plus', label: 'Manager / Lead', from: 'Manager+' },
]
export const SENIORITY_BELOW = { key: 'below', label: 'Below manager' }

function keywordsFor(optionLabel) {
  return SENIORITY_OPTIONS.find(o => o.label === optionLabel)?.keywords || []
}

// Two documented departures from the filter vocabulary, both because a
// CLASSIFIER pays a different price for a false positive than a FILTER does.
// A filter that over-matches merely shows you an extra row you can ignore. A
// classifier that over-matches promotes someone to the top of a ranked call
// list, pushing a real C-suite relationship below a mis-read one. So:
//
//   'president'  is only C-suite when it is not the tail of 'vice president'.
//                SVP/EVP/"Vice President, Strategy" are Director/VP, and on
//                the measured account VP titles outnumber true presidents.
//   'md'         is dropped here. As a bounded token it matches a physician's
//                post-nominal ("Sarah Khan, MD") as readily as a managing
//                director. In the import filter that costs one spurious row;
//                in a ranked backlog it puts a doctor above a real MD.
//                'managing director' still matches in full, which is how
//                virtually every real MD title is actually written.
const DROP_FROM_C_SUITE = new Set(['md'])
const VP_PHRASES = ['vice president', 'vice-president', 'svp', 'evp']

// Phrases that contain a C-suite keyword but are not C-suite roles. Every one
// of these was found in a real 753-contact network, not invented:
//
//   'business partner'   "Finance Business Partner", "Human Resources Business
//                        Partner" — a mid-level embedded specialist role, and
//                        one of the most common titles in large corporates. The
//                        bare keyword 'partner' promoted them to the top of the
//                        call list above real equity partners.
//   'associate partner'  Consulting grade below partner. Senior, not C-suite.
//
// These are stripped before the C-suite test only. A Finance Business Partner
// still classifies normally on everything else.
const NOT_C_SUITE_PHRASES = ['business partner', 'associate partner']

function textForCSuite(titleText) {
  let t = titleText
  for (const phrase of [...VP_PHRASES, ...NOT_C_SUITE_PHRASES]) {
    if (keywordMatches(t, phrase)) t = t.split(phrase).join(' ')
  }
  return t
}

// A recruiter in the network is a competitor, not a lead.
//
// Found while validating against the real data: the network contains other
// search professionals — "Managing Director | Finance & Accountancy Recruiter |
// Headhunter", "Managing Director, AI & Technology Recruitment & Executive
// Search". They classify as C-suite and would rank at the very top of the
// backlog, so the first names a recruiter sees on their own call list would be
// rival recruiters. Nobody pitches a search mandate to a headhunter.
//
// Flagged rather than deleted: they are real relationships and may be referral
// partners. Ranking excludes them; the CRM keeps them.
const COMPETITOR_KEYWORDS = [
  'recruiter', 'recruitment', 'headhunter', 'head-hunter', 'executive search',
  'talent acquisition', 'staffing', 'resourcer', 'search firm',
]

export function isLikelyCompetitor(title, company = '') {
  const text = `${title || ''} ${company || ''}`.toLowerCase().trim()
  if (!text) return false
  return COMPETITOR_KEYWORDS.some(k => keywordMatches(text, k))
}

// Returns a band key, or 'below' when a title carries no seniority marker at
// all. Never returns null for a non-empty title: an unranked row is invisible
// to the backlog, and "no marker" is itself information (it usually means an
// individual contributor).
export function deriveSeniorityBand(title, company = '') {
  const raw = `${title || ''} ${company || ''}`.toLowerCase().trim()
  if (!raw) return null

  for (const band of SENIORITY_BANDS) {
    let keywords = keywordsFor(band.from)
    let text = raw
    if (band.key === 'c_suite') {
      keywords = keywords.filter(k => !DROP_FROM_C_SUITE.has(k))
      text = textForCSuite(raw)
    }
    if (keywords.some(k => keywordMatches(text, k))) return band.key
    // The filter vocabulary lists 'vp' but not 'svp'/'evp', and keywordMatches
    // is correctly boundary-aware, so 'vp' does NOT match inside "SVP" — the
    // 's' in front is a word character. Left alone, "SVP Corporate
    // Development" scores no seniority marker at all and lands in 'below',
    // burying a genuine senior relationship at the bottom of the backlog.
    // Caught by the test for exactly that title.
    if (band.key === 'director_vp' && VP_PHRASES.some(p => keywordMatches(raw, p))) {
      return band.key
    }
  }
  return SENIORITY_BELOW.key
}

// Parent functions only — the flat list also carries narrowed "Parent > Sub"
// entries, which are a filter affordance, not a classification.
const PARENT_FUNCTIONS = FLAT_FUNCTION_OPTIONS.filter(f => !f.label.includes(' > '))

// A title can honestly belong to more than one function: "Head of Regulatory
// Affairs" sits in both Policy & Government Affairs and Healthcare & Clinical,
// because both taxonomies claim that phrase. Rather than pick silently, score
// by how many of a function's keywords hit, break ties on the most specific
// (longest) single match, and fall back to declaration order. Returns the
// parent label so it reads the same way the customer chose it at onboarding.
export function deriveFunctionArea(title, company = '') {
  const text = `${title || ''} ${company || ''}`.toLowerCase().trim()
  if (!text) return null

  let best = null
  for (const fn of PARENT_FUNCTIONS) {
    const hits = fn.keywords.filter(k => keywordMatches(text, k))
    if (!hits.length) continue
    const longest = hits.reduce((a, b) => (b.length > a.length ? b : a), '')
    const score = { label: fn.label, count: hits.length, longest: longest.length }
    if (!best
      || score.count > best.count
      || (score.count === best.count && score.longest > best.longest)) {
      best = score
    }
  }
  return best ? best.label : null
}

// The relationship ladder, in one place so nothing invents a fourth rung.
//
//   connection  connected, but no channel of your own. STILL GENERATES LEADS:
//               a job move at this person's employer is a lead whether or not
//               you can email them — the action is a LinkedIn message or a
//               call. On the measured account 735 of 753 sat here.
//   contact     a real channel exists: work email or phone.
//   client      proven two-way history. Only the mailbox backfill can earn
//               this, because only it can show an exchange actually happened.
//
// hasTwoWayHistory is passed in rather than inferred. Nothing should be able
// to promote someone to 'client' by guessing.
export function deriveRelationshipTier({ email, phone, hasTwoWayHistory = false } = {}) {
  if (hasTwoWayHistory) return 'client'
  const reachable = (email && String(email).trim()) || (phone && String(phone).trim())
  return reachable ? 'contact' : 'connection'
}

// Facets for one imported or edited row, in the shape the columns expect.
export function deriveContactFacets(contact = {}) {
  return {
    seniority_band: deriveSeniorityBand(contact.title, contact.company),
    function_area: deriveFunctionArea(contact.title, contact.company),
    relationship_tier: deriveRelationshipTier(contact),
    is_competitor: isLikelyCompetitor(contact.title, contact.company),
  }
}
