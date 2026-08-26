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

export function createJob(row, userId) {
  return supabase.from('jobs').insert({ ...row, user_id: userId }).select().single()
}

export function updateJob(id, row) {
  return supabase.from('jobs').update(row).eq('id', id).select().single()
}

export function deleteJob(id) {
  return supabase.from('jobs').delete().eq('id', id)
}
