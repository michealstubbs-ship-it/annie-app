// Shared, lightweight company-name matching used wherever we need to tell if
// two free-text company names refer to the same company without a shared ID
// to join on (a signal's AI-written company name vs a contact imported from
// a LinkedIn export, for example). Deliberately simple: strip common legal
// suffixes and punctuation, compare, allow containment for short variants
// ("Acme" inside "Acme Group Holdings"). Not bulletproof, good enough to
// surface a likely match for a human to glance at and confirm.

// 2026-08-26: added the common UAE/GCC legal-entity suffixes (fze, dmcc,
// pjsc, psc, wll, fz, establishment/est) — this list previously only
// covered US/UK-style suffixes, so a genuinely correct match like "Acme
// Trading" (as an AI-written signal names it) vs. Apollo's own registered
// record "Acme Trading FZE" normalized to two different keys and was
// treated as two different companies everywhere this function is used,
// including pickBestOrgMatch's org-resolution step scanShared.js's
// verifyContact depends on — a real, structural gap for Annie's core UAE/
// GCC market specifically, not a US/UK one.
const LEGAL_SUFFIXES = /\b(ltd|limited|llc|inc|incorporated|plc|corp|corporation|group|holdings|co|fze|fz|dmcc|pjsc|psc|wll|establishment|est)\b\.?/g

export function normalizeCompanyName(name) {
  return (name || '')
    .toLowerCase()
    // GCC entity suffixes are routinely written with periods between every
    // letter ("W.L.L.") — strip periods before the suffix regex runs, or
    // "wll" never matches "w.l.l." at all. Collapses to "wll", not "w l l":
    // periods are removed outright (not turned into spaces) so the letters
    // stay joined, same as "Ltd." already relied on via the regex's own
    // trailing `\.?`.
    .replace(/\./g, '')
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

// findWarmContacts was removed on 2026-09-04. It returned every contact whose
// company name matched a signal's, and its own comment described the result as
// "a warm door" the dashboard could offer "instead of only ever suggesting a
// cold approach". Nothing about a name in a CRM makes a door warm: measured on
// the production account, 753 contacts had ZERO notes and ZERO logged calls,
// every one bulk-imported, so that claim was false for all of them.
//
// The Intelligence Feed's way-in ladder replaces it (src/lib/stream/wayIn.js).
// It ranks a route in by the evidence that actually exists — a note the
// recruiter wrote, a candidate who works there now, a bare CRM name, or
// nothing — and only the first of those is ever allowed to read as warm.
