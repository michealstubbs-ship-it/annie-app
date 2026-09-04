import { supabase } from '../supabase'

// Every raw Supabase call the Team Performance dashboard needs, in one
// place, same convention as contacts.js/candidates.js/companies.js. No new
// tables: this reads straight off candidate_job_links, meetings,
// company_documents, invoices, invoice_splits and jobs, all of which
// already exist and are already team-scoped by RLS, so nothing here adds a
// client-side team_id filter. Every read below throws on a Supabase error
// instead of falling back to `data || []`, same fix as every other
// data/*.js file in this codebase.
//
// The pure math that turns these rows into per-recruiter numbers lives in
// teamPerformanceView.js, not here, so it can be unit tested without a
// database. This file's only job is fetching the right rows for the
// selected period and handing them over in the shape that function expects.

// Pipeline activity in the period: every candidate_job_links row whose
// stage last changed on or after periodStartIso. This is what makes the
// pipeline numbers move with the timeline filter instead of staying a flat
// snapshot (see teamPerformanceView.js's own header comment).
export async function listPipelineActivity(periodStartIso) {
  const { data, error } = await supabase
    .from('candidate_job_links')
    .select('stage, owner_id, stage_changed_at')
    .gte('stage_changed_at', periodStartIso)
  if (error) throw error
  return data || []
}

// Meetings held/logged in the period. title/meeting_type ride along purely
// for the drill-down list (so "3 meetings" can expand into what they
// actually were); meetingsCount itself only ever needs user_id/meeting_date.
export async function listMeetingsInPeriod(periodStartIso) {
  const { data, error } = await supabase
    .from('meetings')
    .select('user_id, meeting_date, title, meeting_type')
    .gte('meeting_date', periodStartIso)
  if (error) throw error
  return data || []
}

// Documents (terms of business, in practice) uploaded in the period,
// credited_to already resolved by the fill_company_document_credit trigger
// for any row inserted after that migration, and backfilled to user_id for
// everything before it. file_name/company name ride along for the
// drill-down list, same reasoning as listMeetingsInPeriod above.
export async function listTermsDocsInPeriod(periodStartIso) {
  const { data, error } = await supabase
    .from('company_documents')
    .select('id, credited_to, user_id, uploaded_at, company_id, file_name, companies(name)')
    .gte('uploaded_at', periodStartIso)
  if (error) throw error
  return data || []
}

// Invoices issued in the period, excluding void ones. Status not void
// rather than status = 'paid' only, since a sent-but-unpaid invoice still
// represents a real placement a recruiter should get credit for making,
// not just cash actually collected.
export async function listInvoicesInPeriod(periodStartIso) {
  const { data, error } = await supabase
    .from('invoices')
    .select('id, job_id, total, currency, issue_date, status')
    .gte('issue_date', periodStartIso)
    .neq('status', 'void')
  if (error) throw error
  return data || []
}

// Every split row for the given invoice ids, returned pre-grouped into a
// Map<invoiceId, splits[]> since that's exactly the shape
// computeTeamPerformance's splitsByInvoiceId parameter wants, and it saves
// every caller from re-grouping the same flat list itself.
export async function listSplitsForInvoices(invoiceIds) {
  const byInvoice = new Map()
  if (!invoiceIds?.length) return byInvoice
  const { data, error } = await supabase
    .from('invoice_splits')
    .select('invoice_id, user_id, split_pct')
    .in('invoice_id', invoiceIds)
  if (error) throw error
  for (const row of data || []) {
    if (!byInvoice.has(row.invoice_id)) byInvoice.set(row.invoice_id, [])
    byInvoice.get(row.invoice_id).push(row)
  }
  return byInvoice
}

// jobs.owner_id for a specific set of job ids, as a Map<jobId, ownerId>.
// The no-split fallback needs this for every job an in-period invoice
// points at, not just jobs that are currently live.
export async function getJobOwnersByIds(jobIds) {
  const byJob = new Map()
  if (!jobIds?.length) return byJob
  const { data, error } = await supabase.from('jobs').select('id, owner_id').in('id', jobIds)
  if (error) throw error
  for (const row of data || []) byJob.set(row.id, row.owner_id)
  return byJob
}

// Live jobs right now, not period-filtered (see teamPerformanceView.js for
// why), same active/onhold definition Companies.jsx already uses for
// "open jobs" (listActiveJobsForPicker), plus owner_id and enough fields to
// render a drill-down row.
export async function listLiveJobsForPerformance() {
  const { data, error } = await supabase
    .from('jobs')
    .select('id, title, owner_id, likelihood, companies(name)')
    .in('status', ['active', 'onhold'])
    .order('title')
  if (error) throw error
  return data || []
}

// One call that fetches everything computeTeamPerformance needs for a given
// period start, already shaped for it. The page component calls this once
// per period switch rather than orchestrating six separate calls itself.
export async function loadTeamPerformanceData(periodStartIso) {
  const [pipelineLinks, meetings, termsDocs, invoices, liveJobs] = await Promise.all([
    listPipelineActivity(periodStartIso),
    listMeetingsInPeriod(periodStartIso),
    listTermsDocsInPeriod(periodStartIso),
    listInvoicesInPeriod(periodStartIso),
    listLiveJobsForPerformance(),
  ])

  const invoiceIds = invoices.map(i => i.id)
  const jobIdsFromInvoices = [...new Set(invoices.map(i => i.job_id).filter(Boolean))]
  const [splitsByInvoiceId, jobOwnerById] = await Promise.all([
    listSplitsForInvoices(invoiceIds),
    getJobOwnersByIds(jobIdsFromInvoices),
  ])

  return { pipelineLinks, meetings, termsDocs, invoices, liveJobs, splitsByInvoiceId, jobOwnerById }
}
