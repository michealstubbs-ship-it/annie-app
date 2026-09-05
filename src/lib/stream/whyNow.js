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
