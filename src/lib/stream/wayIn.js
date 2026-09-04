// The "way in" ladder — what replaced the contact gate.
//
// Until 2026-09-04 a signal only reached the customer if Apollo had already
// returned a verified contact for it (isEligibleSourced's
// `if (!s.contact_verified && !s.contact_candidates?.length) return false`).
// Measured over seven days on five tenants: 338 of 446 BD signals were
// researched, enriched, and then never shown to anybody. 82% in the GCC.
// Among them Man Group filing for an ADGM licence, Aldar's AED 38bn Dubai
// joint venture, and Stake's $31M Series B.
//
// Michael, 2026-09-04: the contact was never the product. The lead is. So
// nothing is hidden for lacking a contact any more — instead every item is
// ranked by the strength of the route in, and says plainly which rung it is
// on. The rungs, strongest first:
//
//   1  spoken     someone at that company the recruiter has ACTUALLY dealt
//                 with — a note they wrote, or a logged contact date
//   2  candidate  a candidate on their books who works there right now
//   3  contact    a contact at that company with no interaction history —
//                 a name, nothing more
//   4  cold       nobody; a LinkedIn route only
//
// Previous/alumni candidates are deliberately NOT a rung — Michael's
// explicit call, 2026-09-04.
//
// Rung 1 is earned, not given. Measured on the production account holding
// 753 contacts: ZERO have a note and ZERO have a logged contact date, all
// bulk-imported. So on day one essentially every customer sits on rungs 3
// and 4, and rung 1 only appears once they start logging what they did.
// That is why logging a note is a first-class action in the stream.

import { normalizeCompanyName } from '../companyMatch.js'

export const RUNG_SPOKEN = 1
export const RUNG_CANDIDATE = 2
export const RUNG_CONTACT = 3
export const RUNG_COLD = 4

// Matching a signal's company against CRM records is where honesty is won or
// lost, and the codebase had three different answers to the same question:
// exact lowercase equality in the Today's Actions pools, fuzzy containment in
// companiesMatch, and normalizeCompanyName-only in the feed dedup.
//
// companiesMatch's containment rule is the dangerous one. normalizeCompanyName
// strips legal suffixes, and "group" is one of them — so "Capital Group"
// reduces to the single token "capital", which is contained in "Capital One".
// Measured against the real 753-contact account: substring matching produced
// 12 hits across 37 signals and SEVEN were different companies. It offered
// contacts at `du` (the telecom operator) as a way into Commercial Bank of
// Dubai, and a contact at `Emirates` (the airline) as a way into ALAS Emirates
// Ready Mix.
//
// A false "you already know someone here" is worse than silence: it puts the
// recruiter into a call believing a relationship exists. So containment now
// requires the shorter name to be at least TWO tokens and to sit at a word
// boundary. That single rule rejects all seven false positives above while
// keeping every genuine match (Investcorp, Fasset, L'IMAD, and Al-Futtaim
// Finance against its parent Al-Futtaim).
function tokensOf(name) {
  const n = normalizeCompanyName(name)
  return n ? n.split(' ').filter(Boolean) : []
}

// 'exact'  — the same company
// 'parent' — one name is a word-boundary extension of the other, so almost
//            always a parent/subsidiary or a division. Real, but the person
//            may sit in a different entity, and the UI must say so.
// null     — not a match. Say nothing.
export function companyRelation(signalCompany, recordCompany) {
  const a = tokensOf(signalCompany)
  const b = tokensOf(recordCompany)
  if (!a.length || !b.length) return null
  const ja = a.join(' ')
  const jb = b.join(' ')
  if (ja === jb) return 'exact'
  const [shortT, longT] = a.length <= b.length ? [a, b] : [b, a]
  // A single surviving token is far too weak to extend on — that is exactly
  // how "capital" reached "Capital One".
  if (shortT.length < 2) return null
  const short = shortT.join(' ')
  const long = longT.join(' ')
  // Word-boundary containment, not raw substring.
  if (long === short || long.startsWith(short + ' ') || long.endsWith(' ' + short) || long.includes(' ' + short + ' ')) {
    return 'parent'
  }
  return null
}

// A contact counts as "spoken to" only when the CUSTOMER left evidence they
// dealt with them. Annie never infers warmth from a name existing in the CRM
// — that is what companyMatch.js's own comment used to offer ("so the
// dashboard can offer a warm door instead of only ever suggesting a cold
// approach") on the strength of a company-name match alone.
export function hasRealHistory(contact) {
  if (!contact) return false
  if (contact.last_contacted) return true
  const notes = typeof contact.notes === 'string' ? contact.notes.trim() : ''
  return notes.length > 0
}

// Candidates count for rung 2 only while they actually work there. A previous
// candidate who has moved on is not a way in — Michael, 2026-09-04.
const CLOSED_CANDIDATE_STATUSES = new Set(['placed', 'rejected', 'withdrawn'])

function candidateIsCurrent(candidate) {
  if (!candidate) return false
  const status = (candidate.status || '').toLowerCase()
  return !CLOSED_CANDIDATE_STATUSES.has(status)
}

/**
 * Works out how the recruiter can get into this company, and what Annie is
 * allowed to claim about it.
 *
 * Returns:
 *   rung        1-4, see the constants above
 *   kind        'spoken' | 'candidate' | 'contact' | 'cold'
 *   person      the matched contact or candidate, or null
 *   relation    'exact' | 'parent' | null — how the company name matched
 *   caveat      the honest qualifier the UI must show, or null
 *   nearMisses  companies rejected by the matcher, so the UI can show its
 *               working rather than looking like it simply found nothing
 */
export function computeWayIn(signal, { contacts = [], candidates = [] } = {}) {
  const company = signal?.company_name
  if (!company) {
    return { rung: RUNG_COLD, kind: 'cold', person: null, relation: null, caveat: null, nearMisses: [] }
  }

  const matchedContacts = []
  const nearMisses = []
  for (const c of contacts) {
    if (!c?.company) continue
    const relation = companyRelation(company, c.company)
    if (relation) matchedContacts.push({ contact: c, relation })
    else if (isNearMiss(company, c.company)) nearMisses.push(c.company)
  }

  const matchedCandidates = []
  for (const cd of candidates) {
    if (!cd?.company || !candidateIsCurrent(cd)) continue
    const relation = companyRelation(company, cd.company)
    if (relation) matchedCandidates.push({ candidate: cd, relation })
  }

  const uniqueNearMisses = [...new Set(nearMisses)].slice(0, 2)

  // Rung 1 — a contact they have actually dealt with. Exact company matches
  // outrank parent matches; among equals, the most recently contacted wins.
  const spoken = matchedContacts
    .filter(m => hasRealHistory(m.contact))
    .sort(byRelationThenRecency)[0]
  if (spoken) {
    return {
      rung: RUNG_SPOKEN,
      kind: 'spoken',
      person: spoken.contact,
      relation: spoken.relation,
      caveat: spoken.relation === 'parent' ? parentCaveat(company, spoken.contact.company) : null,
      nearMisses: uniqueNearMisses,
    }
  }

  // Rung 2 — a candidate who works there now. Real, and genuinely useful, but
  // it carries a risk the UI has to name out loud: approaching a company
  // through someone who is actively looking to leave it can burn both.
  const insider = matchedCandidates.sort((a, b) => relationRank(a.relation) - relationRank(b.relation))[0]
  if (insider) {
    return {
      rung: RUNG_CANDIDATE,
      kind: 'candidate',
      person: insider.candidate,
      relation: insider.relation,
      caveat: insider.relation === 'parent'
        ? parentCaveat(company, insider.candidate.company)
        : 'They are on your books as a candidate. Tread carefully if they are actively looking.',
      nearMisses: uniqueNearMisses,
    }
  }

  // Rung 3 — a name in the CRM and nothing more.
  const bare = matchedContacts.sort(byRelationThenRecency)[0]
  if (bare) {
    return {
      rung: RUNG_CONTACT,
      kind: 'contact',
      person: bare.contact,
      relation: bare.relation,
      caveat: bare.relation === 'parent'
        ? parentCaveat(company, bare.contact.company)
        : 'No calls or notes logged, so this is a name rather than a relationship.',
      nearMisses: uniqueNearMisses,
    }
  }

  return { rung: RUNG_COLD, kind: 'cold', person: null, relation: null, caveat: null, nearMisses: uniqueNearMisses }
}

function parentCaveat(signalCompany, recordCompany) {
  return `${recordCompany}, not ${signalCompany} — same group, different entity, so they may not know the hiring manager.`
}

function relationRank(relation) {
  return relation === 'exact' ? 0 : 1
}

function byRelationThenRecency(a, b) {
  const r = relationRank(a.relation) - relationRank(b.relation)
  if (r !== 0) return r
  const ta = a.contact?.last_contacted ? new Date(a.contact.last_contacted).getTime() : 0
  const tb = b.contact?.last_contacted ? new Date(b.contact.last_contacted).getTime() : 0
  return tb - ta
}

// Words that carry no identity. A company sharing one of these with another is
// not a near miss, it is a coincidence — and listing it makes the product look
// like it cannot tell companies apart.
//
// 2026-09-04, found by actually looking at the deployed page: a live_job at
// "Xantory Tech Reseller General Trading LLC SOC" was reporting near-misses
// against "Real Estate General Authority", "Disrupt-X : Deep Tech IoT..." and
// "Saudi Arabian General Investment Authority" — on the strength of the words
// "general" and "tech". Three rejections listed, none of them a company anyone
// could mistake for the target.
const GENERIC_TOKENS = new Set([
  'tech', 'technology', 'technologies', 'general', 'trading', 'global',
  'international', 'national', 'digital', 'services', 'solutions', 'systems',
  'consulting', 'industries', 'enterprises', 'ventures', 'partners',
  'development', 'projects', 'contracting', 'engineering', 'properties',
  'estate', 'realty', 'energy', 'power', 'health', 'medical', 'financial',
  'finance', 'insurance', 'media', 'united', 'first', 'prime', 'advanced',
  'smart', 'modern', 'middle', 'east', 'gulf', 'arab', 'emirates', 'saudi',
  'dubai', 'abu', 'dhabi', 'qatar', 'kuwait', 'oman', 'bahrain', 'london',
])

// Only surfaced so the UI can say "you have contacts at X and Y, they are
// different companies" — showing the working is what makes the silence read as
// judgement rather than as a gap. But it earns that only when the near miss is
// one a person could actually make.
//
// The test is deliberately narrow: the two names must share the FIRST token of
// the signal's company name — its distinctive head, the part someone would
// actually confuse. "Capital Group" and "Capital One" share "capital" and are
// a genuine near miss worth naming. "Xantory Tech" and "Deep Tech IoT" share
// only a category word and are not.
function isNearMiss(signalCompany, recordCompany) {
  const head = tokensOf(signalCompany)[0]
  if (!head || head.length < 4 || GENERIC_TOKENS.has(head)) return false
  return tokensOf(recordCompany).includes(head)
}
