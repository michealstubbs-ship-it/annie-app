// Everyone else you know at this company, and what that list means.
//
// Michael, 2026-09-05, on the shipped card: "It says you know 7 other people
// who work there, there should be a tab taking you them on another list."
//
// So the number becomes a list. But a list of seven names is not an answer
// either — it is seven more things to read. The readout at the bottom is the
// part that does the work: it says what shape the relationship is. On the real
// Khazna row that is "strategy and delivery, and no commercial route in",
// which is a fact about the account a recruiter can act on, computed from the
// facets already stored on every contact.
//
// Nothing here calls anything. It is the CRM the customer already owns,
// grouped by company for the first time.

import { SENIORITY_BANDS, SENIORITY_BELOW } from '../contactFacets'
import { companyRelation } from './wayIn'
import { isPlaceholderCompany } from '../backlogRanking'

const BAND_ORDER = new Map([...SENIORITY_BANDS.map(b => b.key), SENIORITY_BELOW.key].map((k, i) => [k, i]))
const BAND_SHORT = {
  c_suite: 'C-suite',
  director_vp: 'Dir/VP',
  manager_plus: 'Manager',
  [SENIORITY_BELOW.key]: 'Below',
}

// Plain-English counts. "Two C-suite" reads; "2 c_suite contacts" does not.
const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
function count(n) { return n <= 10 ? WORDS[n] : String(n) }

function list(items) {
  if (items.length <= 1) return items[0] || ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

function bandPhrase(band, n) {
  if (band === 'c_suite') return `${count(n)} C-suite`
  if (band === 'director_vp') return `${count(n)} at director or head level`
  if (band === 'manager_plus') return `${count(n)} ${n === 1 ? 'manager' : 'managers'}`
  return `${count(n)} below manager`
}

/**
 * The panel data for one card.
 *
 * signal    the signal the card is about
 * wayIn     so the person already named on the card is not listed twice
 * contacts  the whole CRM
 * functions the functions the customer told us they recruit into
 *
 * Returns null when there is nobody else — the card then simply does not show
 * the block, rather than showing an empty one.
 */
export function buildCompanyPanel({ signal, wayIn = null, contacts = [], functions = [] } = {}) {
  const company = signal?.company_name
  if (!company || isPlaceholderCompany(company)) return null

  // Whoever the card is already about. Both ids matter: the backlog sets
  // linked_contact_id, the way-in ladder sets wayIn.person.
  const onCard = new Set([wayIn?.person?.id, signal?.linked_contact_id].filter(Boolean))

  const others = []
  let parentOnly = 0
  for (const c of contacts) {
    if (!c || onCard.has(c.id)) continue
    const relation = companyRelation(company, c.company)
    if (!relation) continue
    if (relation === 'parent') parentOnly += 1
    others.push({
      id: c.id,
      name: c.name || 'Unnamed contact',
      title: c.title || '',
      company: c.company || '',
      band: c.seniority_band || SENIORITY_BELOW.key,
      bandLabel: BAND_SHORT[c.seniority_band] || BAND_SHORT[SENIORITY_BELOW.key],
      functionArea: c.function_area || null,
      isCompetitor: c.is_competitor === true,
      // The one thing that makes a name a relationship rather than a row.
      spokenTo: Boolean(c.last_contacted || (c.notes || '').trim()),
      relation,
      linkedinUrl: c.linkedin_url || null,
    })
  }

  if (!others.length) return null

  others.sort((a, b) => {
    const band = (BAND_ORDER.get(a.band) ?? 9) - (BAND_ORDER.get(b.band) ?? 9)
    if (band !== 0) return band
    return String(a.name).localeCompare(String(b.name))
  })

  return {
    company,
    others,
    // Total includes the person on the card, because that is the number the
    // recruiter counts: "I know four people at NEOM."
    total: others.length + (onCard.size ? 1 : 0),
    parentOnly,
    readout: readoutFor(others, functions),
  }
}

/**
 * What the list means, in one or two sentences.
 *
 * This is the part Michael's critique was actually about. A count tells a
 * recruiter nothing; "strategy and delivery, no commercial route in" tells
 * them how to play the account.
 */
export function readoutFor(others = [], functions = []) {
  if (!others.length) return null

  const byBand = new Map()
  for (const p of others) byBand.set(p.band, (byBand.get(p.band) || 0) + 1)
  const mix = [...SENIORITY_BANDS.map(b => b.key), SENIORITY_BELOW.key]
    .filter(k => byBand.get(k))
    .map(k => bandPhrase(k, byBand.get(k)))

  const areas = [...new Set(others.map(p => p.functionArea).filter(Boolean))]
  const chosen = functions.filter(Boolean)
  const inFunction = chosen.length
    ? others.filter(p => p.functionArea && chosen.includes(p.functionArea)).length
    : 0

  const sentences = []

  let opener = mix.length ? `${list(mix)}` : `${count(others.length)} ${others.length === 1 ? 'contact' : 'contacts'}`
  if (areas.length) opener += `, across ${list(areas.slice(0, 3))}`
  sentences.push(opener)

  if (chosen.length) {
    if (inFunction === 0) {
      sentences.push('none of them sits in a function you recruit into, so this is a way into the company rather than a way into the role')
    } else if (inFunction === others.length) {
      sentences.push('every one of them sits in a function you recruit into')
    } else {
      // "One of the two SITS", "Four of the five SIT". Read against the real
      // account, which is where this was wrong.
      sentences.push(`${count(inFunction)} of the ${count(others.length)} ${inFunction === 1 ? 'sits' : 'sit'} in functions you recruit into`)
    }
  }

  // Said only when it is true, because it is the strongest fact on the card.
  const spoken = others.filter(p => p.spokenTo)
  if (spoken.length) {
    sentences.push(`you have logged contact with ${list(spoken.map(p => String(p.name).split(' ')[0]))} before`)
  }

  // Deliberately NO competitor line here. is_competitor is a title-keyword
  // classifier, and inside this panel every person is BY DEFINITION at the
  // company on the card — so an in-house "Talent Acquisition Lead" at Emirates
  // NBD tripped it and the readout told the customer their own contact was
  // "at a search firm, not the company itself", which is simply false. Caught
  // by running this over the real 753-contact account rather than a fixture.
  // The flag still does its job in the backlog ranking, where the question is
  // whether to call the person at all.

  return sentences.map(cap).join('. ').replace(/\.\s*$/, '') + '.'
}

function cap(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s
}
