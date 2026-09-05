// The address row on the card.
//
// Michael, 2026-09-05: "surely they should still have the ability to try and
// get the email of the contact? if Apollo doesnt have it, then annie can guess
// it from public records and say that it is a guess."
//
// Measured on his own Apollo account the same day: a person match costs a
// credit whether or not an address comes back, and roughly half come back
// empty — weakest on exactly the Gulf employers he works with. So the choice
// on a card with no address was: spend a credit on a coin flip, or nothing.
// This adds the third option, and is explicit that it is the third option.
//
// The precedence is the honest one, strongest first:
//   1  an address already on the contact record — the customer's own data
//   2  an address Apollo verified for this signal
//   3  a construction from the organisation's format and its domain
//
// (3) is ALWAYS labelled a guess and can never set contact_verified. That rule
// predates this file and is not negotiable: a verified badge means Apollo
// matched a real person, and nothing else may ever produce one.

import { guessEmail, describePattern, domainOf } from '../emailPattern'

/**
 * item      the stream item
 * person    the contact the card is about, if there is one
 * domain    the organisation's domain, from company_enrichment
 * pattern   { pattern, confidence, source } learned for that domain, or null
 *
 * Returns null when there is nothing to show — no person, or no domain to
 * build from. An empty row is worse than no row.
 */
export function cardEmail({ item, person = null, domain = null, pattern = null } = {}) {
  const s = item?.signal || {}
  const subject = person || (s.contact_name ? { name: s.contact_name, email: s.contact_email } : null)
  if (!subject?.name) return null

  if (person?.email) {
    return {
      email: person.email,
      status: 'known',
      badge: 'In your CRM',
      explain: 'This address is already on their contact record.',
      canVerify: false,
    }
  }

  if (s.contact_email && s.contact_verified) {
    return {
      email: s.contact_email,
      status: 'verified',
      badge: 'Verified',
      explain: 'Apollo matched this person and returned this address.',
      canVerify: false,
    }
  }

  const d = domain || domainOf(s.contact_email) || null
  if (!d) return null

  const built = guessEmail({ name: subject.name, domain: d, pattern: pattern?.pattern, confidence: pattern?.confidence })
  if (!built) return null

  return {
    email: built.email,
    status: 'guess',
    badge: 'Guess',
    explain: explainGuess({ domain: d, built, pattern }),
    canVerify: true,
    pattern: built.pattern,
    basis: built.basis,
  }
}

// Saying where a guess came from is the difference between a tool and a
// gamble. The three sentences differ because the three situations genuinely
// differ in how much they are worth.
function explainGuess({ domain, built, pattern }) {
  const format = describePattern(built.pattern)
  const tail = ' Not from Apollo and not confirmed — treat it as a lead, not a fact. If it bounces, that is the answer.'

  if (built.basis === 'observed' && pattern?.source === 'own') {
    const n = pattern.sampleCount || 0
    return `Built from ${domain}, using the ${format} format that ${n === 1 ? 'an address' : `${n} addresses`} you already hold at this company follow${n === 1 ? 's' : ''}.${tail}`
  }
  if (built.basis === 'observed') {
    // The pooled case. What was shared is the format; no customer's address
    // and no customer's identity moved.
    return `Built from ${domain}, using the ${format} format Annie has learned this organisation uses. Annie learns formats, never addresses — nobody's contacts were shared to work this out.${tail}`
  }
  return `Built from ${domain}, which Annie already holds for this company, using ${format} — the most common corporate format. Annie has not seen an address here yet, so this is the weakest kind of guess.${tail}`
}
