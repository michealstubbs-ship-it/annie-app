import { supabase } from '../supabase'

// Raw `jobs` reads used by other pages/pickers — Jobs.jsx itself (the full
// jobs page) still owns its own richer query; these are the narrower shapes
// Companies.jsx and Candidates.jsx each need, pulled out of those
// components for the same reason as contacts.js/candidates.js/companies.js.

// Companies.jsx's company-detail panel: just enough per job to count open
// roles per company client-side (see jobsFor()).
// 2026-08-24: jobs is team-scoped — RLS already restricts every row to the
// caller's active team, so none of the reads below add a client-side
// user_id filter on top of it.
// 2026-08-26 audit fix: every read below now throws on a Supabase error
// instead of silently falling back to `data || []` — see contacts.js's
// header comment for the full reasoning (same fix, same pattern).
export async function listJobsMinimal(userId) {
  const { data, error } = await supabase.from('jobs').select('id, title, status, company_id')
  if (error) throw error
  return data || []
}

// Candidates.jsx's "attach to a job" picker — only jobs still open.
export async function listActiveJobsForPicker(userId) {
  const { data, error } = await supabase
    .from('jobs')
    .select('id, title, companies(name)')
    .in('status', ['active', 'onhold'])
    .order('title')
  if (error) throw error
  return data || []
}

// Jobs.jsx's own list — every job, newest first, with just enough of its
// linked company to show client name/industry/location on the card.
export async function listJobsWithCompanies(userId) {
  const { data, error } = await supabase
    .from('jobs')
    .select('*, companies(name, industry, location)')
    .order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

// Invoices.jsx's job picker — every job for the invoice's selected company,
// including fee_value so the invoice form can prefill a line item from it
// (see JobFormModal's own feeValue calc for where fee_value comes from in
// the first place). Any status, not just open ones — the whole point of
// invoicing is billing for jobs that are usually already filled/closed.
export async function listJobsForCompany(companyId) {
  const { data, error } = await supabase
    .from('jobs')
    .select('id, title, status, fee_value')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

// Pipeline.jsx's own headline stats — just enough per job to sum real
// fees across open/filled mandates. 2026-08-31 audit fix, a real gap
// Michael caught live: "Pipeline Value" used to sum the Pipeline board's
// own freeform, manually-typed deal.value field, including deals still
// at Prospect/Pitch Sent — before anything is confirmed. "You cannot
// measure a value on sending out a proposal": a real dollar figure only
// exists once there's an actual mandate with a real fee, i.e. a row in
// Jobs & Mandates. The Pipeline board's own deal cards keep tracking
// sales activity (stage, probability, notes) exactly as before; their
// typed-in value is still shown per-card as the recruiter's own working
// estimate, it just no longer feeds the headline totals.
export async function listJobsForPipelineSummary() {
  const { data, error } = await supabase.from('jobs').select('status, fee_value')
  if (error) throw error
  return data || []
}

// JobPipeline.jsx's own header — one job, with its linked company name and
// owner_id (resolved to a name client-side via nameForMember, same pattern
// as OwnershipPanel), for the pipeline board's title/stats bar.
export async function getJob(id) {
  const { data, error } = await supabase
    .from('jobs')
    .select('*, companies(name)')
    .eq('id', id)
    .single()
  if (error) throw error
  return data
}

export function createJob(row, userId) {
  return supabase.from('jobs').insert({ ...row, user_id: userId }).select().single()
}

export function updateJob(id, row) {
  return supabase.from('jobs').update(row).eq('id', id).select().single()
}

export function deleteJob(id) {
  return supabase.from('jobs').delete().eq('id', id)
}

// 2026-09-07, gap-analysis batch 8 ("really make sure everything on annie
// is wired up... some things operating in separate buckets instead of a
// fluid app"): a candidate marked Placed used to leave their own job
// showing as active/onhold forever, everywhere jobs.status is read
// (Overview's "Open jobs" tile, Companies.jsx's per-company badge,
// Pipeline.jsx's own pipeline-value total). Nothing anywhere ever flipped
// it, no matter which of the two real places a recruiter marks a placement
// from (Candidates.jsx's own status field, or dragging a card to Placed on
// the job's pipeline board; see both call sites of this function).
// Assumes one hire fills the mandate, the same single-hire assumption
// Jobs.jsx's own status set (active/onhold/filled/lost) already encodes.
// A job that genuinely needs several hires still flips to 'filled' on the
// first placement, a real, known scope limit worth a second pass if
// Michael ever runs a multi-hire mandate through Annie. Only touches a job
// that's currently active/onhold: never overwrites one a recruiter
// separately marked 'lost', and is a no-op if it's already 'filled'.
export async function markJobFilledIfOpen(jobId) {
  if (!jobId) return
  const { data: job, error: fetchError } = await supabase.from('jobs').select('id, status').eq('id', jobId).maybeSingle()
  if (fetchError) throw fetchError
  if (!job || !['active', 'onhold'].includes(job.status)) return
  const { error } = await supabase.from('jobs').update({ status: 'filled' }).eq('id', jobId)
  if (error) throw error
}
