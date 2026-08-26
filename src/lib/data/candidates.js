import { supabase } from '../supabase'

// Every raw `candidates` Supabase call, in one place — see contacts.js's
// header comment for why (same 2026-08-22 audit finding, same fix).

// 2026-08-24: candidates is team-scoped — RLS already restricts every row
// to the caller's active team, so none of the reads below add a
// client-side user_id filter on top of it.
// 2026-08-26 audit fix: every read below now throws on a Supabase error
// instead of silently falling back to `data || []` — see contacts.js's
// header comment for the full reasoning (same fix, same pattern).
export async function listCandidatesWithJobs(userId) {
  const { data, error } = await supabase
    .from('candidates')
    .select('*, jobs(title, companies(name))')
    .order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

export function createCandidate(row, userId) {
  return supabase.from('candidates').insert({ ...row, user_id: userId })
}

export function updateCandidate(id, row) {
  return supabase.from('candidates').update(row).eq('id', id)
}

export function deleteCandidate(id) {
  return supabase.from('candidates').delete().eq('id', id)
}

// Jobs.jsx's per-job candidate count — just the job_id of every candidate
// that's linked to one, counted client-side (see candCounts in Jobs.jsx).
export async function listCandidateJobLinks(userId) {
  const { data, error } = await supabase.from('candidates').select('job_id').not('job_id', 'is', null)
  if (error) throw error
  return data || []
}

// Today's Actions' pipeline-match check (see matchCandidatesToSignal) —
// every candidate, just enough fields to match a signal against and to
// show a real name/role/company on a matched card. `company` added
// 2026-08-23 so the pipeline-match box can show a matched candidate's
// actual current employer instead of just a bare name. `notes` added the
// same day so the per-candidate "why" pitch (buildWhyChips/generate() in
// TodaysActions.jsx) has real, recruiter-written substance to ground a
// specific-sounding sentence in, rather than only role/company/industry —
// still nothing invented beyond what's actually on file for that candidate.
export async function listCandidatesForMatching(userId) {
  const { data, error } = await supabase.from('candidates').select('id, name, role, industry, status, company, notes')
  if (error) throw error
  return data || []
}

// Tasks.jsx's "link to a candidate" picker — just a name in a dropdown.
export async function listCandidatesMinimal(userId) {
  const { data, error } = await supabase.from('candidates').select('id, name').order('name')
  if (error) throw error
  return data || []
}

// Invoices.jsx's "candidate placed" picker — every candidate with enough
// fields to filter to the ones linked to the invoice's selected job and to
// show which one is actually marked 'placed'. Any candidate on the job can
// still be picked, not just 'placed' ones — a recruiter sometimes raises
// the invoice before formally flipping the status, and this shouldn't
// block that.
export async function listCandidatesForInvoicePicker() {
  const { data, error } = await supabase.from('candidates').select('id, name, job_id, status').order('name')
  if (error) throw error
  return data || []
}
