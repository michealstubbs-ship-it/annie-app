// Pure aggregation logic for the Team Performance dashboard. Kept separate
// from teamPerformance.js (the raw Supabase reads) so the actual math,
// who gets credit for what and how the period filter is applied, is unit
// tested directly rather than only reachable by loading the page.
//
// 2026-09-06, Michael: "make sure annie is pulling the data properly,
// especially when someone sets the timeline... make sure the back end is
// also solid." Every number here has one precise definition, written down
// once, rather than left implicit in a component:
//
//   Live jobs       a snapshot, right now, not affected by the period
//                    filter (jobs.status active/onhold, owned by the
//                    recruiter). A job has no clean "was live during this
//                    window" answer without tracking every status change,
//                    which this build doesn't do, so this stays a live
//                    count rather than pretending to be period-aware.
//   Pipeline         candidate_job_links whose stage_changed_at falls in
//   (in play,        the selected period, owned by the recruiter. This
//   interviewing,    measures pipeline ACTIVITY in the window, not a
//   offer, rejected) point-in-time snapshot: a candidate who has sat
//                    untouched in the same stage since before the window
//                    won't be counted, on purpose, so this genuinely moves
//                    with the period instead of staying flat.
//                    In play = every non-terminal stage (not rejected,
//                    withdrawn or placed). Interviewing/offer are the two
//                    named sub-stages Michael asked for; rejected is kept
//                    separate rather than folded into "in play".
//   Meetings         meetings.meeting_date in the period; meetings.user_id
//                    is who logged/held it.
//   Terms signed     company_documents.uploaded_at in the period, credited
//                    to company_documents.credited_to (falls back to
//                    user_id for a document uploaded before that column
//                    existed).
//   Placements /     invoices.issue_date in the period, status not void.
//   revenue          Credited through invoice_splits when the invoice has
//                    any (split_pct% of the total, per person); an invoice
//                    with no splits credits its full total to the job's
//                    owner, the same "the job desk wins the fee by
//                    default" rule InvoiceFormModal's own split section
//                    already documents. Revenue is kept PER CURRENCY, never
//                    summed across currencies, since an invoice can be set
//                    to a different currency than the account default
//                    (InvoiceFormModal's own currency picker), and adding a
//                    GBP total to an AED one would silently produce a
//                    meaningless number.

export const PERIOD_OPTIONS = [
  { key: 'month', label: 'This month' },
  { key: '3m', label: 'Last 3 months' },
  { key: '6m', label: 'Last 6 months' },
  { key: '12m', label: 'Last 12 months' },
]

export const DEFAULT_PERIOD = '6m'

// The start of a named period, as a real Date, so a caller can format it
// into whatever the query layer needs (an ISO string for Supabase's
// .gte()). "This month" means the 1st of the current month, not a rolling
// 30 days, since that's what a manager means by "this month" in a review.
export function periodStart(periodKey, now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  switch (periodKey) {
    case 'month':
      return new Date(d.getFullYear(), d.getMonth(), 1)
    case '3m':
      d.setMonth(d.getMonth() - 3)
      return d
    case '12m':
      d.setMonth(d.getMonth() - 12)
      return d
    case '6m':
    default:
      d.setMonth(d.getMonth() - 6)
      return d
  }
}

function emptyRow(member) {
  return {
    id: member.id,
    name: member.name,
    role: member.role,
    liveJobs: [],
    pipeline: { inPlay: 0, interviewing: 0, offer: 0, rejected: 0 },
    meetingsCount: 0,
    meetings: [],
    termsSigned: [],
    placementsCount: 0,
    revenueByCurrency: {},
  }
}

// teamMembers: [{id, name, role}] (listTeamMembers() shape).
// liveJobs: [{id, title, company_id, owner_id, likelihood, ...}].
// pipelineLinks: [{stage, owner_id}] already pre-filtered to the period.
// meetings: [{user_id}] already pre-filtered to the period.
// termsDocs: [{credited_to, user_id, ...}] already pre-filtered to the period.
// invoices: [{id, job_id, total, currency}] already pre-filtered to the period.
// splitsByInvoiceId: Map<invoiceId, [{user_id, split_pct}]>.
// jobOwnerById: Map<jobId, ownerId>, needed for the no-split fallback,
//   covers every job an in-period invoice points at (not just live ones).
//
// A row for anyone not in teamMembers (a former member whose old records
// still point at their user_id) is silently skipped rather than crashing
// or inventing a row for someone no longer on the roster.
export function computeTeamPerformance({
  teamMembers,
  liveJobs = [],
  pipelineLinks = [],
  meetings = [],
  termsDocs = [],
  invoices = [],
  splitsByInvoiceId = new Map(),
  jobOwnerById = new Map(),
}) {
  const rows = new Map((teamMembers || []).map(m => [m.id, emptyRow(m)]))
  const get = id => rows.get(id)

  for (const job of liveJobs) {
    const row = get(job.owner_id)
    if (row) row.liveJobs.push(job)
  }

  for (const link of pipelineLinks) {
    const row = get(link.owner_id)
    if (!row) continue
    if (link.stage === 'rejected') {
      row.pipeline.rejected += 1
    } else if (link.stage !== 'withdrawn' && link.stage !== 'placed') {
      row.pipeline.inPlay += 1
      if (link.stage === 'interviewing') row.pipeline.interviewing += 1
      if (link.stage === 'offer') row.pipeline.offer += 1
    }
  }

  for (const meeting of meetings) {
    const row = get(meeting.user_id)
    if (row) {
      row.meetingsCount += 1
      row.meetings.push(meeting)
    }
  }

  for (const doc of termsDocs) {
    const creditedTo = doc.credited_to || doc.user_id
    const row = get(creditedTo)
    if (row) row.termsSigned.push(doc)
  }

  for (const invoice of invoices) {
    const splits = splitsByInvoiceId.get(invoice.id) || []
    if (splits.length) {
      const creditedIds = new Set()
      for (const split of splits) {
        const row = get(split.user_id)
        if (!row) continue
        const amount = (Number(invoice.total) || 0) * (Number(split.split_pct) / 100)
        row.revenueByCurrency[invoice.currency] = (row.revenueByCurrency[invoice.currency] || 0) + amount
        creditedIds.add(split.user_id)
      }
      for (const id of creditedIds) get(id).placementsCount += 1
    } else {
      const ownerId = jobOwnerById.get(invoice.job_id)
      const row = ownerId ? get(ownerId) : null
      if (row) {
        row.revenueByCurrency[invoice.currency] = (row.revenueByCurrency[invoice.currency] || 0) + (Number(invoice.total) || 0)
        row.placementsCount += 1
      }
    }
  }

  return [...rows.values()]
}

// Team-wide totals for the summary tiles, a straight sum of the
// per-recruiter rows above, computed here once instead of separately in
// the component, so the tiles can never drift from what the rows below
// them actually add up to.
export function summarizeTeam(rows) {
  const totals = {
    liveJobs: 0,
    pipelineInPlay: 0,
    meetingsCount: 0,
    termsSignedCount: 0,
    placementsCount: 0,
    revenueByCurrency: {},
  }
  for (const row of rows || []) {
    totals.liveJobs += row.liveJobs.length
    totals.pipelineInPlay += row.pipeline.inPlay
    totals.meetingsCount += row.meetingsCount
    totals.termsSignedCount += row.termsSigned.length
    totals.placementsCount += row.placementsCount
    for (const [currency, amount] of Object.entries(row.revenueByCurrency)) {
      totals.revenueByCurrency[currency] = (totals.revenueByCurrency[currency] || 0) + amount
    }
  }
  return totals
}
