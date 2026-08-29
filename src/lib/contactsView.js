// Pure helpers behind Contacts.jsx's status filter chips, sortable columns,
// and status grouping — kept out of the component so this logic is
// unit-testable the same way the rest of this codebase already is (see
// candidateMatch.js, chatHistory.js) rather than only reachable through a
// rendered page.
//
// 2026-08-29 audit fix, flagged directly: Contacts.jsx used to be a single
// flat table in whatever order the database returned, with only a
// free-text search box — "a big list of names all in one." This is the
// filtering/sorting/grouping behind the new controls.

export const CONTACT_STATUSES = ['hot', 'warm', 'cold', 'client', 'inactive']

export const CONTACT_STATUS_LABELS = {
  hot: 'Hot',
  warm: 'Warm',
  cold: 'Cold',
  client: 'Client',
  inactive: 'Inactive',
}

export function searchContacts(contacts, search) {
  const q = (search || '').trim().toLowerCase()
  if (!q) return contacts
  return contacts.filter(c => [c.name, c.company, c.title, c.email].some(f => f?.toLowerCase().includes(q)))
}

export function filterContactsByStatus(contacts, status) {
  if (!status || status === 'all') return contacts
  return contacts.filter(c => c.status === status)
}

const SORTABLE_CONTACT_FIELDS = ['name', 'company', 'title', 'status']

// sortKey of null/undefined (or an unrecognized key) leaves the given order
// untouched — that's the database's own order (newest-first), a legitimate
// "no sort applied yet" state, not an error.
export function sortContacts(contacts, sortKey, sortDir = 'asc') {
  if (!sortKey || !SORTABLE_CONTACT_FIELDS.includes(sortKey)) return contacts
  const dir = sortDir === 'desc' ? -1 : 1
  return [...contacts].sort((a, b) => {
    const av = (a[sortKey] || '').toString().toLowerCase()
    const bv = (b[sortKey] || '').toString().toLowerCase()
    if (av < bv) return -1 * dir
    if (av > bv) return 1 * dir
    return 0
  })
}

// Groups contacts into status-ordered sections for the grouped view shown
// when no status filter is active: hot, warm, cold, client, inactive, then
// an "Other" bucket for any status value outside that known set (shouldn't
// happen in practice, but a stray/legacy value shouldn't silently vanish
// from the page). Preserves whatever order `contacts` was already in within
// each group — callers sort first, then group. Empty groups are omitted.
export function groupContactsByStatus(contacts) {
  const byStatus = new Map()
  for (const c of contacts) {
    const key = CONTACT_STATUSES.includes(c.status) ? c.status : 'other'
    if (!byStatus.has(key)) byStatus.set(key, [])
    byStatus.get(key).push(c)
  }
  const order = [...CONTACT_STATUSES, 'other']
  return order
    .filter(key => byStatus.has(key))
    .map(key => ({ status: key, label: key === 'other' ? 'Other' : CONTACT_STATUS_LABELS[key], contacts: byStatus.get(key) }))
}
