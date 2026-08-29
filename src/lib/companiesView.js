// Pure helpers behind Companies.jsx's industry filter chips and sort
// control — see contactsView.js's header comment for why this logic lives
// outside the component.
//
// 2026-08-29 audit fix, flagged directly alongside the Contacts.jsx fix:
// Companies.jsx's card grid had no way to narrow or reorder a large list —
// only alphabetical-ish order plus free-text search. This is the
// filtering/sorting behind the new industry chips + sort control.

export function listIndustries(companies) {
  const set = new Set(companies.map(c => c.industry).filter(Boolean))
  return [...set].sort((a, b) => a.localeCompare(b))
}

export function searchCompanies(companies, search) {
  const q = (search || '').trim().toLowerCase()
  if (!q) return companies
  return companies.filter(c => c.name.toLowerCase().includes(q))
}

export function filterCompaniesByIndustry(companies, industry) {
  if (!industry || industry === 'all') return companies
  return companies.filter(c => c.industry === industry)
}

// `counts` is a plain { [companyId]: { contacts, openJobs } } map, built by
// the caller from data it already has loaded (contacts/jobs are separate
// tables — this module has no data access of its own, same separation as
// every other lib/*.js helper in this codebase).
const SORTERS = {
  name: (a, b) => a.name.localeCompare(b.name),
  contacts: (a, b, counts) => (counts[b.id]?.contacts || 0) - (counts[a.id]?.contacts || 0) || a.name.localeCompare(b.name),
  jobs: (a, b, counts) => (counts[b.id]?.openJobs || 0) - (counts[a.id]?.openJobs || 0) || a.name.localeCompare(b.name),
}

export function sortCompanies(companies, sortBy, counts = {}) {
  const sorter = SORTERS[sortBy] || SORTERS.name
  return [...companies].sort((a, b) => sorter(a, b, counts))
}
