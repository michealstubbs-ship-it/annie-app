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

// 2026-09-03: moved here from Candidates.jsx (previously defined inline,
// only used there) so the Job Pipeline board's cards/columns can share the
// exact same 9-stage colour set instead of a second, driftable copy —
// same "one source of truth" reasoning as STAGES/STAGE_LABEL above.
export const STAGE_COLOR = {
  sourced: 'bg-slate-100 text-slate-600',
  screening: 'bg-blue-100 text-blue-700',
  shortlisted: 'bg-purple-100 text-purple-700',
  presented: 'bg-amber-100 text-amber-700',
  interviewing: 'bg-orange-100 text-orange-700',
  offer: 'bg-emerald-100 text-emerald-700',
  placed: 'bg-yellow-100 text-gold',
  rejected: 'bg-red-100 text-red-600',
  withdrawn: 'bg-gray-100 text-gray-500',
}

export const VISA_STATUS_LABEL = {
  own_visa: 'Own visa',
  needs_sponsorship: 'Needs sponsorship',
  sponsored_by_agency: 'Agency-sponsored',
  not_required: 'Not required',
}

export const VISA_TYPE_LABEL = {
  employment: 'Employment', golden: 'Golden', dependent: 'Dependent', freelance: 'Freelance', visit: 'Visit', other: 'Other',
}

// 2026-09-06, gap-analysis batch 1 ("visa & sponsorship status tracking"):
// the expiry-countdown badge — same "five-minute glance" reasoning as the
// existing hotlist/counter-offer badges. Pure date math so it's testable
// without a real Date-dependent component render; `today` is injectable
// for tests, defaults to now for real callers.
export function visaExpiryBadge(visaExpiry, today = new Date()) {
  if (!visaExpiry) return null
  const expiry = new Date(visaExpiry + 'T00:00:00')
  const days = Math.ceil((expiry - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000)
  if (days < 0) return { days, label: `Visa expired ${Math.abs(days)}d ago`, level: 'critical' }
  if (days <= 30) return { days, label: `Visa expires in ${days}d`, level: 'critical' }
  if (days <= 90) return { days, label: `Visa expires in ${days}d`, level: 'watch' }
  return { days, label: `Visa valid ${days}d`, level: 'ok' }
}

export function searchCandidates(candidates, search) {
  const q = (search || '').trim().toLowerCase()
  if (!q) return candidates
  // nationality added 2026-09-04 (Michael: "add a nationality function") —
  // same free-text field as location/industry, so it gets the same search
  // treatment as soon as it exists on a candidate row.
  return candidates.filter(c => [c.name, c.role, c.company, c.location, c.industry, c.nationality, c.email].some(f => f?.toLowerCase().includes(q)))
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
