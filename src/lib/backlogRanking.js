// Ranking the relationships the customer already has and has never used.
//
// THE MEASUREMENT THAT PRODUCED THIS FILE. On a real 753-contact account:
// 328 C-suite/Partner and 272 Director/VP/Head, and every single one of the
// 753 had last_contacted = null. Six hundred senior relationships, none ever
// called. The market scan running alongside it was surfacing RD MEP
// Management and The Justice Law Office.
//
// So the highest-yield lead source was never the open market — it was the
// backlog sitting in the CRM on day one. It needs no scan, no Apollo credit,
// no second CSV import and no waiting for something to change.
//
// This module is pure and has no Supabase or network dependency, so the
// ranking can be reasoned about and tested directly. It decides WHO; the
// caller decides how many and what to do with them.
import { SENIORITY_BANDS } from './contactFacets'

// A company name that is not a company. All of these are real values from the
// measured account: LinkedIn shows "Confidential" when a member hides their
// employer, and it lands in the CSV as though it were a company. Eight rows on
// that one account, and "Confidential" was ALSO the top card in the live
// Intelligence Feed the day the feed was reviewed (FEED-1) — the same bug
// arriving through two different doors.
//
// A lead has to be a lead at a real, nameable employer. If we cannot say where
// the person works, we cannot tell the recruiter who to call.
const PLACEHOLDER_COMPANIES = new Set([
  'confidential', 'confidential government', 'confidential company',
  'private', 'undisclosed', 'stealth', 'stealth startup', 'stealth mode',
  'self-employed', 'self employed', 'freelance', 'freelancer', 'independent',
  'unemployed', 'retired', 'n/a', 'na', 'none', '-', '--', 'tbc', 'tbd',
])

export function isPlaceholderCompany(name) {
  const n = String(name || '').trim().toLowerCase()
  if (!n) return true
  if (PLACEHOLDER_COMPANIES.has(n)) return true
  // "Confidential Portfolio Company", "Confidential - Government Entity" etc.
  if (n.startsWith('confidential')) return true
  if (n.startsWith('stealth')) return true
  return false
}

// Seniority is the dominant term: this is a list of people who can commission a
// search. The gaps are deliberately wide — a C-suite relationship outranks a
// Director one even when the Director scores maximum account depth, because in
// executive search the person who signs the mandate is the whole game.
export const SENIORITY_SCORE = {
  c_suite: 100,
  director_vp: 65,
  manager_plus: 20,
  below: 0,
}

// Knowing several people somewhere is qualitatively different from knowing one.
// On the measured account: Khazna Data Centers 7 contacts (3 C-suite), ADQ 4
// (2 C-suite), NEOM 4 (2 C-suite) — those are real accounts, not a stray
// connection. Capped so a single large employer cannot dominate the whole list.
export const DEPTH_PER_EXTRA_CONTACT = 8
export const DEPTH_CAP = 32

// Connection recency is a TIE-BREAKER, not a driver, and the direction is
// deliberate: someone connected recently is likelier to remember you, so the
// call is easier and converts sooner. The opposite case — a senior contact from
// years back who has since moved — is a genuinely strong lead, but it is the
// job-move detector's job to find it, not this one's. Modelling it twice would
// double-count the same person.
export function recencyBonus(connectedOn, now = new Date()) {
  if (!connectedOn) return 0
  const parsed = Date.parse(connectedOn)
  if (Number.isNaN(parsed)) return 0
  const years = (now.getTime() - parsed) / (1000 * 60 * 60 * 24 * 365)
  if (years < 0) return 0
  if (years <= 1) return 12
  if (years <= 3) return 8
  if (years <= 6) return 4
  return 0
}

// Reasons a contact never reaches the call list at all. Kept separate from
// scoring, and each one returns its reason, so the exclusion is inspectable
// rather than a silent disappearance.
export function exclusionReason(contact, { functions = [] } = {}) {
  if (!contact) return 'empty'

  // Found by validating the classifier against the real network: a recruiter's
  // connections include other recruiters, and they classify as C-suite. Without
  // this the first names on the list would be rival headhunters.
  if (contact.is_competitor) return 'competitor'

  if (isPlaceholderCompany(contact.company)) return 'no_real_employer'

  // Below manager cannot commission a search. This is the one place the
  // seniority band is used as a gate rather than a weight.
  if (!contact.seniority_band || contact.seniority_band === 'below') return 'too_junior'

  // FEED-6 was a regulatory/HSE lead reaching a recruiter who works in
  // Strategy, Finance and Technology. The function filter existed in onboarding
  // and was never enforced anywhere. It is enforced here.
  //
  // An unclassified contact is NOT excluded: a title Annie could not read is a
  // failure of the classifier, and silently dropping those people would hide
  // real relationships. They score lower instead, via functionFit.
  if (functions.length && contact.function_area && !functions.includes(contact.function_area)) {
    return 'wrong_function'
  }

  // Already in flight. Once the mailbox sync lands this is what stops Annie
  // recommending someone the recruiter spoke to last week.
  if (contact.last_contacted) return 'already_contacted'

  return null
}

// A contact whose function Annie could not read still belongs on the list, but
// below the ones it could confirm — an unreadable title is weaker evidence than
// a matching one, and pretending otherwise would rank a guess alongside a fact.
export function functionFit(contact, { functions = [] } = {}) {
  if (!functions.length) return 1
  if (!contact.function_area) return 0.75
  return functions.includes(contact.function_area) ? 1 : 0
}

// depthByCompany: normalised company name -> how many contacts the customer has
// there. Passed in rather than computed here so one pass over the CRM serves
// the whole ranking.
export function scoreContact(contact, { functions = [], depthByCompany = new Map(), now = new Date() } = {}) {
  const excluded = exclusionReason(contact, { functions })
  if (excluded) return { score: 0, excluded, reasons: [] }

  const reasons = []
  const seniority = SENIORITY_SCORE[contact.seniority_band] ?? 0
  const bandLabel = SENIORITY_BANDS.find(b => b.key === contact.seniority_band)?.label
  if (bandLabel) reasons.push(bandLabel)

  const key = String(contact.company || '').trim().toLowerCase()
  const atCompany = depthByCompany.get(key) || 1
  const depth = Math.min((atCompany - 1) * DEPTH_PER_EXTRA_CONTACT, DEPTH_CAP)
  if (atCompany > 1) reasons.push(`you know ${atCompany} people at ${contact.company}`)

  const recency = recencyBonus(contact.connected_on, now)

  const score = (seniority + depth + recency) * functionFit(contact, { functions })
  return { score, excluded: null, reasons, atCompany }
}

// One pass over the CRM: index company depth, score everyone, drop the
// excluded, sort, and cap.
//
// The cap matters more than it looks. Six hundred qualifying contacts poured
// into the feed at once is not a call list, it is the same undifferentiated
// wall the CRM already was. A recruiter works a handful of BD calls a day, so
// the feed holds a small live set and replenishes as they are actioned.
export const DEFAULT_BACKLOG_LIMIT = 8

export function buildCompanyDepth(contacts = []) {
  const depth = new Map()
  for (const c of contacts) {
    const key = String(c?.company || '').trim().toLowerCase()
    if (!key) continue
    depth.set(key, (depth.get(key) || 0) + 1)
  }
  return depth
}

export function rankBacklog(contacts = [], { functions = [], limit = DEFAULT_BACKLOG_LIMIT, now = new Date(), exclude = new Set() } = {}) {
  const depthByCompany = buildCompanyDepth(contacts)
  const scored = []

  for (const contact of contacts) {
    if (!contact?.id || exclude.has(contact.id)) continue
    const result = scoreContact(contact, { functions, depthByCompany, now })
    if (result.excluded || result.score <= 0) continue
    scored.push({ contact, ...result })
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    // Stable, name-ordered tie-break so the same CRM always produces the same
    // list. A backlog that reshuffles between page loads reads as broken.
    return String(a.contact.name || '').localeCompare(String(b.contact.name || ''))
  })

  return scored.slice(0, limit)
}

// Why this person, in the recruiter's own terms.
//
// Deliberately plain. An earlier draft of this product wrote "a senior person
// in a new seat, with a budget and something to prove — the warmest call in
// recruitment", and the reaction from the recruiter reading it was that nobody
// talks that way. It says what is true and stops.
export function backlogHeadline(contact) {
  const name = contact?.name || 'A contact'
  const company = contact?.company || 'their company'
  return `${name} at ${company}`
}

export function backlogWhyItMatters(entry) {
  const { contact, atCompany } = entry
  const parts = []
  const band = SENIORITY_BANDS.find(b => b.key === contact.seniority_band)
  if (band) parts.push(`${contact.title || band.label} at ${contact.company}`)
  parts.push('in your network, never contacted')
  if (atCompany > 1) parts.push(`you know ${atCompany} people there`)
  return `${parts.join('. ')}.`
}
