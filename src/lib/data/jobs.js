import { supabase } from '../supabase'

// Raw `jobs` reads used by other pages/pickers — Jobs.jsx itself (the full
// jobs page) still owns its own richer query; these are the narrower shapes
// Companies.jsx and Candidates.jsx each need, pulled out of those
// components for the same reason as contacts.js/candidates.js/companies.js.

// Companies.jsx's company-detail panel: just enough per job to count open
// roles per company client-side (see jobsFor()).
export async function listJobsMinimal(userId) {
  const { data } = await supabase.from('jobs').select('id, title, status, company_id').eq('user_id', userId)
  return data || []
}

// Candidates.jsx's "attach to a job" picker — only jobs still open.
export async function listActiveJobsForPicker(userId) {
  const { data } = await supabase
    .from('jobs')
    .select('id, title, companies(name)')
    .eq('user_id', userId)
    .in('status', ['active', 'onhold'])
    .order('title')
  return data || []
}

// Jobs.jsx's own list — every job, newest first, with just enough of its
// linked company to show client name/industry/location on the card.
export async function listJobsWithCompanies(userId) {
  const { data } = await supabase
    .from('jobs')
    .select('*, companies(name, industry, location)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
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
