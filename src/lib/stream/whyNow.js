// One sentence a recruiter would actually say.
//
// The product accumulated seven overlapping ways to describe how relevant a
// card is — signal type, state, way-in rung, relationship tier, seniority band,
// function area, competitor flag — and surfaced most of them. A recruiter needs
// one answer to one question: why this person, today. Everything else is
// machinery that should stay behind the glass.
//
// This does not replace the way-in panel, which explains WHO you know and how
// well. It replaces the reader having to assemble the answer themselves out of
// a type chip, a rung label and a headline.
//
// COPY RULE, Michael 2026-09-05: no recruiter-marketing language. He named
// "bench", "new seat", "budget and something to prove" and "the warmest call in
// recruitment" as things nobody actually says. Plain sentences, or nothing.
import { BACKLOG_SIGNAL_TYPE } from './backlogSignals'
import { RUNG_SPOKEN, RUNG_CANDIDATE, RUNG_CONTACT } from './wayIn'

function peopleAt(company, contacts = []) {
  if (!company) return 0
  const target = String(company).trim().toLowerCase()
  return contacts.filter(c => String(c?.company || '').trim().toLowerCase() === target).length
}

function seniorAt(company, contacts = []) {
  if (!company) return 0
  const target = String(company).trim().toLowerCase()
  return contacts.filter(c =>
    String(c?.company || '').trim().toLowerCase() === target && c?.seniority_band === 'c_suite').length
}

/**
 * The one line under the headline.
 *
 * Returns null when there is nothing true and useful to say — an empty string
 * would render an empty row, and a generic line ("this could be an
 * opportunity") is worse than no line at all because it trains the reader to
 * skip it.
 */
export function whyNow(item, contacts = []) {
  if (!item?.signal) return null
  const s = item.signal
  const company = s.company_name
  const known = peopleAt(company, contacts)
  const senior = seniorAt(company, contacts)

  // How many you know there, said once, in the form a recruiter would use.
  const depth = known > 1
    ? `You know ${known} people at ${company}${senior > 1 ? `, ${senior} of them C-suite` : ''}`
    : known === 1
      ? `You know someone at ${company}`
      : null

  if (s.signal_type === BACKLOG_SIGNAL_TYPE) {
    // The backlog's whole argument: this is a real relationship you have never
    // used. Nothing changed — that IS the point, and saying so plainly is more
    // honest than manufacturing an event.
    return depth
      ? `${depth}, and have never contacted any of them.`
      : `In your network, never contacted.`
  }

  // A job move or promotion. The card headline already says what happened, so
  // this says why it is worth a call rather than repeating the event.
  if (s.linked_contact_id && s.signal_type === 'leadership_change') {
    return depth
      ? `${depth}. That is a live need at a company you can already get into.`
      : 'Someone you know has moved, so both sides of that move are worth a call.'
  }

  // Everything else is an event at a company inside the network — which, since
  // the scan was scoped, is the only kind that reaches the feed.
  const rung = item.wayIn?.rung
  if (rung === RUNG_SPOKEN) {
    return depth
      ? `${depth} and you have spoken to one of them before.`
      : 'You have spoken to someone here before.'
  }
  if (rung === RUNG_CANDIDATE) {
    return 'One of your candidates works here, so you already know the inside of this business.'
  }
  if (rung === RUNG_CONTACT && depth) {
    return `${depth}. Nobody has been called yet.`
  }
  return depth ? `${depth}.` : null
}

// LinkedIn headlines are not job titles. Real rows on the production account:
// "Managing Partner | Global Practice Leader Growth & Transformation" and
// "Chief Digital Officer, Global Head of Digital & AI". Dropped into a
// sentence whole they read as noise, so the sentence takes the first title and
// the card's own role line still shows the full string.
export function shortTitle(raw) {
  const first = String(raw || '').split(/\s*[|•—–]\s*/)[0].trim()
  const trimmed = first.length > 46 ? first.split(/\s*,\s*/)[0].trim() : first
  return trimmed.length > 60 ? '' : trimmed
}

// "one of two C-suite people", not "one of 2". A numeral mid-sentence reads
// like a database field, which is exactly what a recruiter should not see.
const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
function numberWord(n) { return n <= 10 ? NUMBER_WORDS[n] : String(n) }

// Why HIM, not why the company.
//
// Michael, 2026-09-05, on the shipped card: "it doesnt say why to approach
// this guy." He was right, and the fault was structural rather than cosmetic:
// whyNow above answers "why this company, today", and the card had nothing
// that answered "why this person". Every fact needed to answer it was already
// stored on the contact — seniority band, function area, and how they stand
// against everyone else the recruiter knows there — and none of it was said.
//
// Three clauses at most, in the order a recruiter would think them:
//   1  what this person controls, and whether it is a function they work in
//   2  where they sit among the people already known at that company
//   3  whether anybody there has actually been called
export function whyPerson(person, { company, contacts = [], functions = [] } = {}) {
  if (!person?.name) return null
  const title = shortTitle(person.title)
  const band = person.seniority_band
  const area = person.function_area
  const target = String(company || person.company || '').trim().toLowerCase()

  const at = contacts.filter(c => String(c?.company || '').trim().toLowerCase() === target)
  const clauses = []

  // 1. What they control.
  const chosen = functions.filter(Boolean)
  const inFunction = area && chosen.includes(area)
  if (title && inFunction) {
    clauses.push(`A ${title} holds the budget in ${area}, one of the functions you recruit into`)
  } else if (title && band === 'c_suite') {
    clauses.push(`A ${title} is senior enough to open a door in any function`)
  } else if (title) {
    clauses.push(`A ${title} is close enough to the hiring to be worth a call`)
  } else if (band === 'c_suite') {
    clauses.push('C-suite, so senior enough to open a door in any function')
  }

  // 2. Where they stand among the people already known there.
  // No pronouns anywhere in here. Annie does not know anyone's gender and must
  // not infer one from a name — half this CRM is Gulf and South Asian names,
  // and getting it wrong in the customer's own outreach is unforgivable.
  const seniors = at.filter(c => c.seniority_band === 'c_suite')
  if (band === 'c_suite' && seniors.length === 1 && at.length > 1) {
    clauses.push(`the most senior person you know at ${company}`)
  } else if (band === 'c_suite' && seniors.length > 1) {
    clauses.push(`one of ${numberWord(seniors.length)} C-suite people you know at ${company}`)
  } else if (at.length > 1) {
    clauses.push(`one of ${numberWord(at.length)} people you know at ${company}`)
  }

  // 3. Whether anybody there has been called. The absence IS the argument.
  const called = at.some(c => c.last_contacted || (c.notes || '').trim())
  clauses.push(called ? 'and you have history at this company' : 'and nobody there has been called')

  if (clauses.length === 1) return null
  const [head, ...tail] = clauses
  return `${head} — ${tail.join(', ')}.`
}
