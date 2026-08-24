// Small render-time helpers shared by index.jsx — kept separate from the
// component so the JSX file stays focused on layout, and so these are each
// independently testable without mounting anything.

// The candidate/bench-strength angles a sourced signal can lead with when
// there's no real pipeline match to show instead — a real match always
// outranks these.
export function buildApproaches(action) {
  const approaches = []
  if (action.candidateAngle) approaches.push({ key: 'candidate', icon: '🎯', label: 'Lead with a candidate', tone: 'default', content: action.candidateAngle })
  if (action.benchStrengthAngle) approaches.push({ key: 'bench', icon: '💪', label: 'Lead with our experience', tone: 'default', content: action.benchStrengthAngle })
  return approaches
}

// Today's BD Actions = anything driven by a real signal Annie found
// (sourced: a brand-new company; relationship: fresh news about a company
// already in the CRM). Worth your follow up = pure CRM housekeeping with no
// news behind it (dormant/meeting/new_client).
export const BD_CATEGORIES = ['sourced', 'relationship']

// The mock never labels a sourced signal "sourced by annie" — that's implied
// by which tab it's in. `sourced` has no entry here on purpose — a plain
// (non-live_job) sourced item renders no badge at all unless it's also
// urgent (handled separately in index.jsx).
export const BADGE = {
  dormant: { label: 're-engage', className: 'bg-amber-100 text-amber-700' },
  meeting: { label: 'meeting', className: 'bg-purple-100 text-purple-700' },
  relationship: { label: 'relationship', className: 'bg-purple-100 text-purple-700' },
  new_client: { label: 'new client', className: 'bg-blue-100 text-blue-700' },
  live_job: { label: 'live role', className: 'bg-green-100 text-green-700' },
}

// A cached action's pipelineMatches may be either the current shape (a
// {name, role, company, industry, status} object per candidate) or the
// older plain-string-name shape it replaced — normalize so render never
// needs to branch on it.
export function normalizeMatch(m) {
  return typeof m === 'string' ? { name: m, role: '', company: '', industry: '', status: '', whyPitch: '' } : m
}

// Honest pills built from fields that are actually real (current company +
// whether it shares the signal's industry, role, CRM status), plus one more
// pill (💡) only when a real, grounded AI pitch exists for this candidate —
// see buildCandidatePitchPrompt in actionsCopy.js. That pill is visibly
// marked as Annie's inference (aiGenerated: true), never presented the same
// way as the honest fact-based pills above it.
export function buildWhyChips(m, action) {
  const chips = []
  if (m.company) {
    const sameSector = action.signalIndustry && m.industry && m.industry.trim().toLowerCase() === action.signalIndustry.trim().toLowerCase()
    chips.push({ icon: '🏢', text: sameSector ? `${m.company}, same sector` : m.company })
  }
  if (m.role) chips.push({ icon: '🎯', text: m.role })
  if (m.status) {
    const label = { warm: 'Warm in your pipeline', active: 'Actively engaged', new: 'New to your pipeline' }[m.status.toLowerCase()] || `${m.status}, in your pipeline`
    chips.push({ icon: '⭐', text: label })
  }
  if (m.whyPitch) chips.push({ icon: '💡', text: m.whyPitch, aiGenerated: true })
  return chips
}
