// Shared, lightweight company-name matching used wherever we need to tell if
// two free-text company names refer to the same company without a shared ID
// to join on (a signal's AI-written company name vs a contact imported from
// a LinkedIn export, for example). Deliberately simple: strip common legal
// suffixes and punctuation, compare, allow containment for short variants
// ("Acme" inside "Acme Group Holdings"). Not bulletproof, good enough to
// surface a likely match for a human to glance at and confirm.

const LEGAL_SUFFIXES = /\b(ltd|limited|llc|inc|incorporated|plc|corp|corporation|group|holdings|co)\b\.?/g

export function normalizeCompanyName(name) {
  return (name || '')
    .toLowerCase()
    .replace(LEGAL_SUFFIXES, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function companiesMatch(a, b) {
  const na = normalizeCompanyName(a)
  const nb = normalizeCompanyName(b)
  if (!na || !nb) return false
  if (na === nb) return true
  // Only allow containment once both sides are long enough that a coincidental
  // substring match is unlikely (a 3-letter name would match half of LinkedIn).
  if (na.length >= 5 && nb.length >= 5) return na.includes(nb) || nb.includes(na)
  return false
}

// A cold outbound email and "someone I already know works there" are not the
// same opportunity. This finds any of the recruiter's own contacts who
// already work at a signal's target company, so the dashboard can offer a
// warm door instead of only ever suggesting a cold approach.
export function findWarmContacts(companyName, contacts) {
  if (!companyName || !contacts?.length) return []
  return contacts.filter(c => c.company && companiesMatch(c.company, companyName))
}
