// Pure helpers behind Candidates.jsx's search box, sort control, and
// stage grouping — see contactsView.js's header comment for why this logic
// lives outside the component.
//
// 2026-08-29 audit fix, following the same "big list" fix already shipped
// for Contacts.jsx/Companies.jsx: Candidates.jsx already had stage filter
// chips, but no search box at all, and "All" was one undifferentiated pile
// of cards in whatever order the database returned — no grouping, no sort.
// STAGES/STAGE_LABEL moved here (previously defined inline in
// Candidates.jsx) so there's exactly one source of truth for the pipeline
// stage list, same reasoning as every other lib/*.js extraction in this
// codebase.

export const STAGES = ['sourced', 'screening', 'shortlisted', 'presented', 'interviewing', 'offer', 'placed', 'rejected', 'withdrawn']

export const STAGE_LABEL = {
  sourced: 'Sourced',
  screening: 'Screening',
  shortlisted: 'Shortlisted',
  presented: 'Presented',
  interviewing: 'Interviewing',
  offer: 'Offer',
  placed: 'Placed',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
}

export function searchCandidates(candidates, search) {
  const q = (search || '').trim().toLowerCase()
  if (!q) return candidates
  return candidates.filter(c => [c.name, c.role, c.company, c.location, c.industry, c.email].some(f => f?.toLowerCase().includes(q)))
}

export function filterCandidatesByStage(candidates, stage) {
  if (!stage || stage === 'all') return candidates
  return candidates.filter(c => c.status === stage)
}

// 'recent' (the default) leaves the given order untouched — the database's
// own newest-first order (see listCandidatesWithJobs), a legitimate "no
// sort applied" state, not a missing case.
const SORTERS = {
  name: (a, b) => (a.name || '').localeCompare(b.name || ''),
  salary: (a, b) => (b.want_sal || 0) - (a.want_sal || 0),
}

export function sortCandidates(candidates, sortBy) {
  const sorter = SORTERS[sortBy]
  if (!sorter) return candidates
  return [...candidates].sort(sorter)
}

// Groups candidates into stage-ordered sections for the grouped view shown
// when no single stage filter is active — same shape/reasoning as
// contactsView.js's groupContactsByStatus. Empty groups are omitted;
// preserves whatever order `candidates` was already in within each group
// (callers sort first, then group).
export function groupCandidatesByStage(candidates) {
  const byStage = new Map()
  for (const c of candidates) {
    const key = STAGES.includes(c.status) ? c.status : 'other'
    if (!byStage.has(key)) byStage.set(key, [])
    byStage.get(key).push(c)
  }
  const order = [...STAGES, 'other']
  return order
    .filter(key => byStage.has(key))
    .map(key => ({ stage: key, label: key === 'other' ? 'Other' : STAGE_LABEL[key], candidates: byStage.get(key) }))
}
